/* Contract test for the Web Bluetooth shim.
 *
 * Runs the real shim source against a fake SynapBleNative and replays the exact
 * call sequence app.js performs during a connect, so a regression in the shim is
 * caught here rather than on a phone with a pendant strapped to it.
 *
 *   node tools/shim-contract.cjs
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SHIM = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'synap-ble-shim.js'),
  'utf8',
);

const SERVICE = '4fa12345-0000-1000-8000-00805f9b34fb';
const AUDIO = '4fa12346-0000-1000-8000-00805f9b34fb';
const CONTROL = '4fa12347-0000-1000-8000-00805f9b34fb';
const ADDRESS = 'AA:BB:CC:DD:EE:FF';

function inventory() {
  const props = (over) => Object.assign(
    { read: true, write: true, writeWithoutResponse: true, notify: true, indicate: false },
    over || {},
  );
  return [{
    uuid: SERVICE,
    characteristics: [
      { uuid: AUDIO, properties: props({ write: false }) },
      { uuid: CONTROL, properties: props() },
    ],
  }];
}

/** Stands in for the Kotlin BleBridge. Records calls, settles on demand. */
function makeNative(window) {
  const calls = [];
  let connected = false;

  function settle(requestId, extra) {
    window.__synapBleNative.dispatch([
      Object.assign({ type: 'settle', requestId, ok: true }, extra || {}),
    ]);
  }

  return {
    calls,
    settle,
    setConnected(value) { connected = value; },
    api: {
      isSupported: () => true,
      isEnabled: () => true,
      isConnected: () => connected,
      inventory: () => JSON.stringify(inventory()),
      mtu: () => 517,
      getDevices: () => JSON.stringify([{ id: ADDRESS, name: 'synap' }]),
      forgetDevice(address) { calls.push(['forgetDevice', address]); },
      requestDevice(options, id) { calls.push(['requestDevice', JSON.parse(options), id]); },
      connect(address, id) { calls.push(['connect', address, id]); connected = true; },
      disconnect(address) { calls.push(['disconnect', address]); connected = false; },
      read(address, service, char, id) { calls.push(['read', service, char, id]); },
      write(address, service, char, base64, withResponse, id) {
        calls.push(['write', service, char, base64, withResponse, id]);
      },
      setNotify(address, service, char, enable, id) {
        calls.push(['setNotify', service, char, enable, id]);
      },
      watchAdvertisements(address) { calls.push(['watchAdvertisements', address]); },
      unwatchAdvertisements(address) { calls.push(['unwatchAdvertisements', address]); },
    },
  };
}

function load() {
  const window = {
    console,
    Promise,
    Error,
    JSON,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Array,
    Object,
    navigator: {},
    AbortController,
  };
  window.window = window;
  const native = makeNative(window);
  window.SynapBleNative = native.api;
  vm.runInNewContext(SHIM, window, { filename: 'synap-ble-shim.js' });
  return { window, native };
}

function lastId(calls, name) {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === name) return calls[i][calls[i].length - 1];
  }
  throw new Error(`no ${name} call recorded`);
}

(async function run() {
  const { window, native } = load();
  const bluetooth = window.navigator.bluetooth;

  assert.ok(bluetooth, 'navigator.bluetooth must be defined');
  assert.strictEqual(typeof bluetooth.requestDevice, 'function');
  assert.strictEqual(typeof bluetooth.getDevices, 'function');
  assert.strictEqual(await bluetooth.getAvailability(), true);

  // runtime-compat.js rebinds requestDevice and tags the object, so it must be
  // a writable property on an extensible object.
  const original = bluetooth.requestDevice;
  bluetooth.requestDevice = function (options) { return original.call(bluetooth, options); };
  bluetooth.__synapDiscoveryCompatInstalled = true;
  assert.strictEqual(bluetooth.__synapDiscoveryCompatInstalled, true,
    'the shim object must accept runtime-compat.js monkey-patching');

  // --- requestDevice, with the filter shape app.js actually sends -----------
  const devicePromise = bluetooth.requestDevice({
    filters: [{ services: [SERVICE] }, { namePrefix: 'synap' }, { namePrefix: 'dk-' }],
    optionalServices: [SERVICE],
  });
  const requestArgs = native.calls.find((c) => c[0] === 'requestDevice');
  assert.deepStrictEqual(requestArgs[1].filters[0].services, [SERVICE]);
  native.settle(requestArgs[2], { id: ADDRESS, name: 'synap' });
  const device = await devicePromise;

  assert.strictEqual(device.id, ADDRESS, 'device.id must be the stable address');
  assert.strictEqual(device.name, 'synap');

  // getDevices must return the same object identity, so listeners survive.
  const [restored] = await bluetooth.getDevices();
  assert.strictEqual(restored, device, 'getDevices must reuse the device instance');

  // --- connect -------------------------------------------------------------
  assert.strictEqual(device.gatt.connected, false);
  const connectPromise = device.gatt.connect();
  native.settle(lastId(native.calls, 'connect'), { id: ADDRESS, mtu: 517 });
  const gatt = await connectPromise;
  assert.strictEqual(gatt, device.gatt);
  assert.strictEqual(device.gatt.connected, true);

  // --- discovery -----------------------------------------------------------
  const service = await device.gatt.getPrimaryService(SERVICE);
  assert.strictEqual(service.uuid, SERVICE);
  const audio = await service.getCharacteristic(AUDIO);
  const control = await service.getCharacteristic(CONTROL);
  assert.strictEqual(await service.getCharacteristic(AUDIO), audio,
    'repeat getCharacteristic must return the same object so listeners stay attached');
  assert.strictEqual(audio.properties.notify, true);
  assert.strictEqual(audio.properties.write, false);

  // --- notifications -------------------------------------------------------
  const subscribe = audio.startNotifications();
  const notifyCall = native.calls.find((c) => c[0] === 'setNotify');
  assert.strictEqual(notifyCall[1], SERVICE);
  assert.strictEqual(notifyCall[2], AUDIO);
  assert.strictEqual(notifyCall[3], true);
  native.settle(notifyCall[4]);
  await subscribe;

  const frames = [];
  audio.addEventListener('characteristicvaluechanged', (event) => {
    frames.push(event.target.value);
  });

  // A batch, exactly as BleBridge coalesces them: order must be preserved and
  // each frame must arrive as its own event with a DataView value.
  window.__synapBleNative.dispatch([
    { type: 'characteristicvaluechanged', id: ADDRESS, service: SERVICE, characteristic: AUDIO, value: 'AAEC' },
    { type: 'characteristicvaluechanged', id: ADDRESS, service: SERVICE, characteristic: AUDIO, value: '//79' },
  ]);
  assert.strictEqual(frames.length, 2, 'every notification in a batch must be dispatched');
  assert.ok(frames[0] instanceof DataView, 'value must be a DataView');
  assert.deepStrictEqual([frames[0].getUint8(0), frames[0].getUint8(1), frames[0].getUint8(2)], [0, 1, 2]);
  assert.deepStrictEqual([frames[1].getUint8(0), frames[1].getUint8(1), frames[1].getUint8(2)], [255, 254, 253]);
  assert.strictEqual(audio.value, frames[1], 'characteristic.value must hold the latest frame');

  // --- read ----------------------------------------------------------------
  const readPromise = control.readValue();
  native.settle(lastId(native.calls, 'read'), { value: 'AQID' });
  const read = await readPromise;
  assert.deepStrictEqual([read.getUint8(0), read.getUint8(1), read.getUint8(2)], [1, 2, 3]);

  // --- writes --------------------------------------------------------------
  const withResponse = control.writeValueWithResponse(new Uint8Array([0x02, 0xff]));
  let call = native.calls[native.calls.length - 1];
  assert.strictEqual(call[0], 'write');
  assert.strictEqual(call[4], true, 'writeValueWithResponse must ask for an acknowledged write');
  assert.strictEqual(call[3], 'Av8=', 'payload must be base64');
  native.settle(call[5]);
  await withResponse;

  const withoutResponse = control.writeValueWithoutResponse(new Uint8Array([0x00]).buffer);
  call = native.calls[native.calls.length - 1];
  assert.strictEqual(call[4], false, 'writeValueWithoutResponse must be unacknowledged');
  native.settle(call[5]);
  await withoutResponse;

  // --- error semantics -----------------------------------------------------
  const failing = control.readValue();
  window.__synapBleNative.dispatch([{
    type: 'settle',
    requestId: lastId(native.calls, 'read'),
    ok: false,
    message: 'Read timed out',
    name: 'TimeoutError',
  }]);
  await assert.rejects(failing, (error) => {
    // app.js branches on TimeoutError to decide whether a native request may
    // still be in flight, so the name has to survive the bridge.
    assert.strictEqual(error.name, 'TimeoutError');
    assert.match(error.message, /timed out/i);
    return true;
  });

  // --- advertisements ------------------------------------------------------
  const controller = new AbortController();
  await device.watchAdvertisements({ signal: controller.signal });
  let advertisements = 0;
  device.addEventListener('advertisementreceived', (event) => {
    advertisements++;
    assert.strictEqual(event.device, device);
  });
  window.__synapBleNative.dispatch([{ type: 'advertisementreceived', id: ADDRESS, rssi: -54 }]);
  assert.strictEqual(advertisements, 1);
  controller.abort();
  assert.strictEqual(native.calls[native.calls.length - 1][0], 'unwatchAdvertisements',
    'aborting the signal must stop the native scan');

  // --- disconnect ----------------------------------------------------------
  let disconnects = 0;
  device.addEventListener('gattserverdisconnected', () => { disconnects++; });
  window.__synapBleNative.dispatch([{ type: 'gattserverdisconnected', id: ADDRESS, status: 19 }]);
  assert.strictEqual(disconnects, 1);
  native.setConnected(false);
  assert.strictEqual(device.gatt.connected, false);

  await assert.rejects(device.gatt.getPrimaryService(SERVICE), /disconnected/i,
    'a dropped link must not hand back stale services');

  // A reconnect must produce fresh characteristic objects, never ones bound to
  // the previous link.
  native.setConnected(true);
  const reconnect = device.gatt.connect();
  native.settle(lastId(native.calls, 'connect'), { id: ADDRESS, mtu: 517 });
  await reconnect;
  const freshService = await device.gatt.getPrimaryService(SERVICE);
  assert.notStrictEqual(freshService, service, 'reconnect must rebuild the service graph');
  assert.notStrictEqual(await freshService.getCharacteristic(AUDIO), audio,
    'reconnect must rebuild characteristics');

  console.log('shim contract: all assertions passed');
}()).catch((error) => {
  console.error(error);
  process.exit(1);
});
