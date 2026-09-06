'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'runtime-compat.js'), 'utf8');
const SYNAP_SERVICE_UUID = '4fa12345-0000-1000-8000-00805f9b34fb';

function makeContext(userAgent) {
  const calls = [];
  const nativeRequestDevice = function (options) {
    calls.push(options);
    return Promise.resolve({ id: 'test-device' });
  };

  const bluetooth = { requestDevice: nativeRequestDevice };
  const context = {
    navigator: {
      userAgent,
      bluetooth,
      locks: { request: async function () {} }
    },
    document: { getElementById: function () { return null; } },
    localStorage: {
      getItem: function () { return null; },
      setItem: function () {},
      removeItem: function () {}
    },
    crypto: { randomUUID: function () { return 'test-owner'; } },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'runtime-compat.js' });
  return { context, bluetooth, calls, nativeRequestDevice };
}

(async function () {
  {
    const { context, bluetooth, calls, nativeRequestDevice } = makeContext(
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36'
    );

    assert.notEqual(bluetooth.requestDevice, nativeRequestDevice, 'Android must install the Synap discovery wrapper');
    assert.equal(context.SynapRuntimeCompat.androidBleDiscoveryCompat, true);

    await bluetooth.requestDevice({
      filters: [{ services: [SYNAP_SERVICE_UUID] }],
      optionalServices: [SYNAP_SERVICE_UUID]
    });

    assert.equal(calls.length, 1);
    const options = calls[0];
    assert(options.filters.some(filter => Array.isArray(filter.services) && filter.services.includes(SYNAP_SERVICE_UUID)), 'service filter must remain');
    assert(options.filters.some(filter => filter.namePrefix === 'synap'), 'current Synap name must be an OR filter');
    assert(options.filters.some(filter => filter.namePrefix === 'dk-'), 'legacy pendant name must remain discoverable');
    assert(options.optionalServices.includes(SYNAP_SERVICE_UUID), 'Synap service must remain available after selection');
  }

  {
    const { bluetooth, calls } = makeContext(
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36'
    );
    const original = { filters: [{ namePrefix: 'OtherDevice' }], optionalServices: ['battery_service'] };
    await bluetooth.requestDevice(original);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], original, 'unrelated Android Bluetooth requests must not be widened');
  }

  {
    const { context, bluetooth, nativeRequestDevice } = makeContext(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile Safari/604.1'
    );
    assert.equal(bluetooth.requestDevice, nativeRequestDevice, 'non-Android browsers must retain their native chooser unchanged');
    assert.equal(context.SynapRuntimeCompat.androidBleDiscoveryCompat, false);
  }

  console.log('android BLE Synap discovery compatibility: ok');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
