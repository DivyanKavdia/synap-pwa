'use strict';
module.exports = function pendantFixture() {
  if (!localStorage.getItem('dk-pendant-auto-reconnect'))
    localStorage.setItem('dk-pendant-auto-reconnect', 'off');
  localStorage.setItem(
    'dk-pendant-settings',
    JSON.stringify({ autoProcess: false, wakeLock: false }),
  );
  const buffered = location.search.includes('buffered');
  const ota = location.search.includes('ota');
  const target = location.search.includes('c3') ? 'esp32c3-supermini-4m' : 'esp32s3-fh4r2-qspi-4m';
  let firmwareBuild = 1200,
    otaState = 1,
    otaSession = 0,
    otaOffset = 0,
    otaBegins = 0,
    otaCommits = 0,
    otaHold = false;
  const otaStatus = () => {
    const v = new DataView(new ArrayBuffer(20));
    v.setUint8(0, 0xd7);
    v.setUint8(1, 3);
    v.setUint8(2, otaState);
    v.setUint32(4, otaSession, true);
    v.setUint32(8, otaOffset, true);
    v.setUint32(12, 0x140000, true);
    v.setUint16(16, 503, true);
    v.setUint16(18, firmwareBuild, true);
    return v;
  };
  let armed = false,
    waiting = false,
    finishing = false,
    owner = [],
    buffer = [],
    sendTimer = null;
  let stopDisconnect = null,
    pauseReplay = false,
    idleOnReconnect = false,
    invalidRecoveryReads = 0;
  const recoveryStatus = () => {
    const v = new DataView(new ArrayBuffer(16));
    v.setUint8(0, 0x52);
    v.setUint8(1, 1);
    v.setUint8(2, 1 + (armed ? 2 : 0) + (waiting ? 4 : 0) + (finishing ? 8 : 0));
    v.setUint16(4, 600, true);
    let hash = 2166136261;
    for (const byte of owner) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    v.setUint32(12, hash, true);
    return v;
  };
  let state = 1,
    sequence = 0,
    audioTimer = null,
    inFlight = 0,
    maxInFlight = 0,
    present = true,
    watching = false;
  let visibility = 'visible',
    hideOnConnect = false,
    appDisconnects = 0,
    statusReads = 0,
    holdRead = false,
    releaseRead = null,
    readError = null;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  function setVisibility(value) {
    visibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }
  const count = (key) => Number(sessionStorage.getItem(key) || 0);
  const increment = (key) => sessionStorage.setItem(key, String(count(key) + 1));
  const uuid = (n) => '4fa123' + n + '-0000-1000-8000-00805f9b34fb';
  const status = () => {
    const v = new DataView(new ArrayBuffer(16));
    v.setUint8(0, 0x5a);
    v.setUint8(1, 2);
    v.setUint8(2, state);
    v.setUint16(4, 512, true);
    v.setUint16(6, 509, true);
    v.setUint8(8, 4);
    v.setUint8(9, 8);
    v.setUint16(10, 16000, true);
    v.setUint16(12, 800, true);
    v.setUint16(14, 400, true);
    return v;
  };
  async function operation(fn) {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight > 1) throw Error('Overlapping GATT requests');
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await fn();
    } finally {
      inFlight--;
    }
  }
  class Characteristic extends EventTarget {
    constructor(id) {
      super();
      this.id = id;
      this.properties = { write: true, read: true, notify: true };
      this.value = null;
    }
    startNotifications() {
      return operation(() => this);
    }
    readValue() {
      return operation(async () => {
        if (this.id === uuid('49')) return otaStatus();
        if (this.id === uuid('4b'))
          return new DataView(
            new TextEncoder().encode('SYNAP-FW:' + target + ':1.0.0:' + firmwareBuild).buffer,
          );
        if (this.id === uuid('4f')) {
          if (invalidRecoveryReads > 0) {
            invalidRecoveryReads--;
            return new DataView(new ArrayBuffer(4));
          }
          return recoveryStatus();
        }
        if (this.id === uuid('47')) {
          statusReads++;
          if (holdRead) {
            holdRead = false;
            await new Promise((resolve) => {
              releaseRead = resolve;
            });
          }
          return status();
        }
        return this.id === uuid('4c')
          ? new DataView(new TextEncoder().encode('SYNAP-ABCDEF123456').buffer)
          : new DataView(new Uint8Array([0xe2, 1, 1, 0, 0x82, 4]).buffer);
      });
    }
    writeValueWithResponse(value) {
      return operation(async () => {
        if (this.id === uuid('48')) {
          const v = new DataView(value.buffer, value.byteOffset, value.byteLength),
            command = value[0];
          if (command === 1) {
            otaBegins++;
            otaSession = v.getUint32(1, true);
            otaOffset = 0;
            otaState = 3;
          }
          if (command === 2) {
            while (otaHold) await new Promise((resolve) => setTimeout(resolve, 10));
            if (v.getUint32(5, true) !== otaOffset) throw Error('Unexpected firmware offset');
            otaOffset += value.length - 9;
          }
          if (command === 3) otaState = 4;
          if (command === 4) {
            otaCommits++;
            otaState = 5;
            firmwareBuild = 1201;
            setTimeout(() => {
              otaState = 1;
              loseLink();
            }, 30);
          }
          if (command === 5) otaState = 6;
          const ack = chars.get(uuid('49'));
          ack.value = otaStatus();
          ack.dispatchEvent(new Event('characteristicvaluechanged'));
          return;
        }
        if (this.id === uuid('4f')) {
          if (value[0] === 1 && state === 1) {
            armed = true;
            owner = [...value.slice(1, 9)];
          }
          if (value[0] === 2 && waiting && owner.every((x, i) => x === value[i + 1])) {
            const last = value[9] + value[10] * 256,
              index = buffer.indexOf(last);
            buffer = buffer.slice(index < 0 ? 0 : index + 1);
            waiting = false;
            startSender();
          }
          return;
        }
        if (buffered && value[0] === 0 && state === 2) {
          if (stopDisconnect === 'before') {
            stopDisconnect = null;
            setVisibility('hidden');
            loseLink();
            throw new DOMException('Link lost before STOP arrived', 'NetworkError');
          }
          clearInterval(audioTimer);
          finishing = true;
          const recovery = chars.get(uuid('4f'));
          recovery.value = recoveryStatus();
          recovery.dispatchEvent(new Event('characteristicvaluechanged'));
          if (stopDisconnect === 'after') {
            stopDisconnect = null;
            setVisibility('hidden');
            loseLink();
            return;
          }
          startSender();
          return;
        }
        if (value[0] === 1) {
          increment('qa-starts');
          state = 2;
          sequence = 0;
          buffer = [];
          finishing = false;
          waiting = false;
          clearInterval(sendTimer);
          sendTimer = null;
          clearInterval(audioTimer);
          audioTimer = setInterval(frame, 50);
        }
        if (value[0] === 0) {
          state = 1;
          clearInterval(audioTimer);
        }
        this.value = status();
        this.dispatchEvent(new Event('characteristicvaluechanged'));
      });
    }
  }
  const audio = new Characteristic(uuid('46')),
    control = new Characteristic(uuid('47'));
  const chars = new Map([
    [uuid('46'), audio],
    [uuid('47'), control],
    [uuid('4c'), new Characteristic(uuid('4c'))],
    [uuid('4e'), new Characteristic(uuid('4e'))],
  ]);
  if (buffered) chars.set(uuid('4f'), new Characteristic(uuid('4f')));
  if (ota) for (const id of ['48', '49', '4b']) chars.set(uuid(id), new Characteristic(uuid(id)));
  const service = {
    getCharacteristic: (id) =>
      operation(() => {
        if (!chars.has(id)) throw new DOMException('No optional characteristic', 'NotFoundError');
        return chars.get(id);
      }),
  };
  const device = new EventTarget();
  device.id = 'fixture-device';
  device.name = 'synap';
  function loseLink() {
    const wasConnected = device.gatt.connected;
    device.gatt.connected = false;
    if (buffered && armed && state === 2) {
      waiting = true;
      clearInterval(sendTimer);
    } else clearInterval(audioTimer);
    if (wasConnected) device.dispatchEvent(new Event('gattserverdisconnected'));
  }
  device.gatt = {
    connected: sessionStorage.getItem('qa-retain-link') === '1',
    connect() {
      increment('qa-connects');
      return operation(() => {
        if (!present) throw new DOMException('Pendant is asleep', 'NetworkError');
        this.connected = true;
        if (idleOnReconnect) {
          idleOnReconnect = false;
          waiting = false;
          finishing = false;
          buffer = [];
          clearInterval(audioTimer);
        }
        if (!waiting) state = 1;
        if (hideOnConnect) {
          hideOnConnect = false;
          setVisibility('hidden');
        }
        return this;
      });
    },
    getPrimaryService() {
      return operation(() => service);
    },
    disconnect() {
      appDisconnects++;
      loseLink();
    },
  };
  device.watchAdvertisements = async ({ signal }) => {
    watching = true;
    signal.addEventListener(
      'abort',
      () => {
        watching = false;
      },
      { once: true },
    );
  };
  function emit(seq) {
    for (let chunk = 0; chunk < 4; chunk++) {
      const v = new DataView(new ArrayBuffer(408));
      v.setUint8(0, 0xa5);
      v.setUint8(1, 2);
      v.setUint16(2, seq, true);
      v.setUint8(4, chunk);
      v.setUint8(5, 4);
      v.setUint16(6, 400, true);
      for (let i = 8; i < 408; i += 2) v.setInt16(i, (seq % 20000) + 1, true);
      audio.value = v;
      audio.dispatchEvent(new Event('characteristicvaluechanged'));
    }
  }
  function startSender() {
    if (sendTimer) clearInterval(sendTimer);
    sendTimer = setInterval(() => {
      if (!device.gatt.connected || waiting || pauseReplay) return;
      if (buffer.length) emit(buffer.shift());
      else if (finishing) {
        clearInterval(sendTimer);
        state = 1;
        finishing = false;
        control.value = status();
        control.dispatchEvent(new Event('characteristicvaluechanged'));
      }
    }, 15);
  }
  function frame() {
    if (buffered) {
      buffer.push(sequence);
      if (buffer.length > 600) buffer.shift();
      if (device.gatt.connected && !waiting && !sendTimer) startSender();
    } else emit(sequence);
    sequence = (sequence + 1) & 65535;
  }
  let pickerError = null,
    bluetoothAvailable = !location.search.includes('lateBluetooth');
  const bluetooth = new EventTarget();
  bluetooth.requestDevice = async () => {
    if (!navigator.userActivation.isActive)
      throw new DOMException('Device selection needs a direct user tap', 'SecurityError');
    increment('qa-pickers');
    if (pickerError) {
      const error = pickerError;
      pickerError = null;
      throw error;
    }
    sessionStorage.setItem('qa-permitted', '1');
    return device;
  };
  if (!location.search.includes('noRestore'))
    bluetooth.getDevices = async () => (sessionStorage.getItem('qa-permitted') ? [device] : []);
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    get: () => (bluetoothAvailable ? bluetooth : undefined),
  });
  window.bleFixture = {
    disconnect: loseLink,
    enableBluetooth() {
      bluetoothAvailable = true;
    },
    rejectNextPicker(name, message) {
      pickerError = new DOMException(message, name);
    },
    get otaBegins() {
      return otaBegins;
    },
    get otaCommits() {
      return otaCommits;
    },
    get otaOffset() {
      return otaOffset;
    },
    get firmwareBuild() {
      return firmwareBuild;
    },
    holdFirmware(value) {
      otaHold = value;
    },
    get maximum() {
      return maxInFlight;
    },
    get watching() {
      return watching;
    },
    get captured() {
      return sequence;
    },
    get pendingFrames() {
      return buffer.length;
    },
    get recoveryWaiting() {
      return waiting;
    },
    get armed() {
      return armed;
    },
    interruptNextStop(mode) {
      stopDisconnect = mode;
    },
    holdReplay(value) {
      pauseReplay = value;
    },
    expireBuffer() {
      idleOnReconnect = true;
    },
    invalidRecoveryOnce() {
      invalidRecoveryReads = 1;
    },
    get appDisconnects() {
      return appDisconnects;
    },
    get statusReads() {
      return statusReads;
    },
    get readError() {
      return readError;
    },
    get readPending() {
      return Boolean(releaseRead);
    },
    hideOnNextConnect() {
      hideOnConnect = true;
    },
    show: () => setVisibility('visible'),
    hide: () => setVisibility('hidden'),
    delayStatusRead() {
      holdRead = true;
      readError = null;
      SynapDevices.connection
        .queue(() => control.readValue(), 'Delayed diagnostic read')
        .catch((error) => {
          readError = error.name;
        });
    },
    finishRead() {
      releaseRead?.();
      releaseRead = null;
    },
    get connects() {
      return count('qa-connects');
    },
    get pickers() {
      return count('qa-pickers');
    },
    get starts() {
      return count('qa-starts');
    },
    disableAdvertisements() {
      delete device.watchAdvertisements;
    },
    sleep() {
      const events = chars.get(uuid('4e'));
      events.value = new DataView(new Uint8Array([0xe2, 1, 3, 1, 0x82, 4]).buffer);
      events.dispatchEvent(new Event('characteristicvaluechanged'));
      present = false;
      loseLink();
    },
    wake() {
      present = true;
      if (watching) {
        const event = new Event('advertisementreceived');
        event.device = device;
        device.dispatchEvent(event);
      }
    },
  };
};
