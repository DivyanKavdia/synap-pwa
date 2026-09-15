/* Module identity comes from firmware, never from the Bluetooth display name. */
(function (root) {
  'use strict';
  const UUID = '4fa12350-0000-1000-8000-00805f9b34fb';
  const IDENTITY = '4fa1234b-0000-1000-8000-00805f9b34fb';
  const COMMAND = '4fa12351-0000-1000-8000-00805f9b34fb';
  const STATUS = '4fa12352-0000-1000-8000-00805f9b34fb';
  const PATH = '4fa12353-0000-1000-8000-00805f9b34fb';
  const profiles = root.SynapDeviceProfiles || require('./profiles.js');
  const capabilities = root.SynapCapabilities || require('./capabilities.js');
  const { FLAGS, BY_MODULE: PROFILES } = profiles;
  const ERRORS = [
    '',
    'Finish the current recording or firmware update first.',
    'Unsupported hardware check.',
    'SD card is unavailable. Check the card and retry.',
    'Camera did not initialize. Check the Sense board connection.',
    'Microphone did not initialize.',
    'SD card needs at least 4 MiB free.',
    'Could not finish writing to the SD card.',
    'Capture failed. Retry the hardware check.',
  ];
  function decode(value) {
    if (
      !value ||
      value.byteLength !== 20 ||
      value.getUint8(0) !== 0xc7 ||
      value.getUint8(1) !== 1 ||
      value.getUint8(3) !== 1
    )
      throw Error('Unsupported module capability descriptor.');
    const profile = PROFILES[value.getUint8(2)];
    if (!profile) throw Error('This Synap module is not recognized by this app.');
    const supported = value.getUint16(4, true),
      ready = value.getUint16(6, true);
    if (ready & ~supported) throw Error('Invalid module readiness flags.');
    return Object.freeze({
      ...profile,
      supported,
      ready,
      sensor: value.getUint16(8, true),
      sampleRate: value.getUint16(10, true),
      flashMiB: value.getUint8(12),
      psramMiB: value.getUint8(13),
      mediaVersion: value.getUint8(14),
      mediaFeatures: profile.id === 3 ? value.getUint8(16) : 0,
      voiceVersion: value.getUint8(15),
      legacy: false,
    });
  }
  function legacy(identity) {
    const match = /^SYNAP-FW:([^:]+):(?:synap-os1-build\d+|\d+\.\d+\.\d+):\d+$/.exec(identity);
    const profile = match && Object.values(PROFILES).find((p) => p.target === match[1]);
    // Chakshu needs the capability protocol; do not expose controls on a name/identity guess.
    return profile && profile.id !== 3
      ? Object.freeze({
          ...profile,
          supported: profile.features.reduce((mask, key) => mask | FLAGS[key], 0),
          ready: 0,
          legacy: true,
        })
      : null;
  }
  function decodeStatus(value) {
    if (
      !value ||
      value.byteLength !== 20 ||
      value.getUint8(0) !== 0xc9 ||
      value.getUint8(1) !== 1 ||
      value.getUint8(2) > 4 ||
      value.getUint8(4) > 3 ||
      value.getUint8(5) > 8 ||
      value.getUint8(7) > 100
    )
      throw Error('Invalid Chakshu hardware-check status.');
    const result = {
      operation: value.getUint8(2),
      id: value.getUint8(3),
      state: value.getUint8(4),
      error: value.getUint8(5),
      ready: value.getUint8(6),
      progress: value.getUint8(7),
      totalMiB: value.getUint32(8, true),
      freeMiB: value.getUint32(12, true),
      bytes: value.getUint32(16, true),
    };
    if (result.freeMiB > result.totalMiB) throw Error('Invalid SD capacity report.');
    return Object.freeze(result);
  }
  class Client {
    constructor(context, changed = () => {}) {
      this.context = context;
      this.changed = changed;
      this.module = null;
      this.status = null;
      this.path = '';
      this.closed = false;
      this.pending = false;
      this.commandPending = false;
      this.characteristics = {};
      this.nextId = 1;
      this.expected = null;
      this.pathKey = '';
      this.error = '';
      this.available = false;
    }
    get busy() {
      return this.commandPending || Boolean(this.expected) || this.status?.state === 1;
    }
    close() {
      this.closed = true;
      this.characteristics = {};
    }
    async characteristic(uuid, queue = this.context.queue) {
      if (!this.characteristics[uuid])
        this.characteristics[uuid] = await queue(
          () => this.context.service.getCharacteristic(uuid),
          'Find module characteristic',
        );
      this.ensure();
      return this.characteristics[uuid];
    }
    ensure() {
      if (this.closed) throw Error('Module connection changed.');
    }
    async read(uuid, queue = this.context.queue) {
      const characteristic = await this.characteristic(uuid, queue);
      const value = await queue(() => characteristic.readValue(), 'Read module status');
      this.ensure();
      return value;
    }
    async identify(queue = this.context.queue) {
      let value;
      try {
        value = await this.read(UUID, queue);
      } catch (error) {
        if (error.name !== 'NotFoundError') throw error;
        this.module = legacy(
          new TextDecoder('utf-8', { fatal: true }).decode(await this.read(IDENTITY, queue)),
        );
        this.available = true;
        return;
      }
      this.module = decode(value);
      this.available = true;
    }
    async updateStatus() {
      const reported = decodeStatus(await this.read(STATUS));
      if (this.expected) {
        if (reported.id === this.expected.id && reported.operation === this.expected.operation)
          this.expected = null;
        else if (Date.now() < this.expected.deadline && reported.state !== 1) return;
        else {
          this.expected = null;
          this.status = reported;
          throw Error(
            reported.state === 1
              ? 'Another hardware check is already running on Chakshu.'
              : 'Chakshu did not confirm this check. Refresh status before trying again.',
          );
        }
      }
      this.status = reported;
      this.nextId = (this.status.id % 255) + 1;
      if (this.status.state !== 1) {
        const key = this.status.id + ':' + this.status.operation;
        if (this.pathKey !== key) {
          const value = await this.read(PATH);
          let bytes = new Uint8Array(
            value.buffer || value,
            value.byteOffset || 0,
            value.byteLength,
          );
          // Chakshu 1227 emitted Snapshot::path as all 64 bytes of a C array.
          // A shorter/new empty path can leave old bytes after its first NUL.
          // Only decode the bounded C string; validate its path below as usual.
          const end = bytes.indexOf(0);
          if (bytes.length === 64 && end >= 0) bytes = bytes.subarray(0, end);
          const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (path && !/^\/synap\/[a-f0-9]{8}-[a-f0-9]{8}\.(jpg|wav|mjpeg)$/.test(path))
            throw Error('Invalid SD file path.');
          this.path = path;
          this.pathKey = key;
        }
      } else this.path = '';
    }
    refresh() {
      if (this.refreshPromise) return this.refreshPromise;
      this.refreshPromise = this.refreshOnce().finally(() => {
        this.refreshPromise = null;
      });
      return this.refreshPromise;
    }
    async refreshOnce() {
      // A resumed audio take may last indefinitely. Read capabilities once on
      // its new link so the camera can be used alongside audio. SD status and
      // subsequent passive polling still wait until recording stops.
      const identifyDuringAudio =
        this.context.canUse?.() === false &&
        !this.available &&
        this.context.canUseMedia?.() === true;
      if (
        this.pending ||
        this.closed ||
        (this.context.canUse?.() === false && !identifyDuringAudio)
      )
        return false;
      this.pending = true;
      try {
        await this.identify(identifyDuringAudio ? this.context.mediaQueue : this.context.queue);
        if (capabilities.isChakshu(this.module) && this.context.canUse?.() !== false)
          await this.updateStatus();
        this.error = '';
        return true;
      } catch (error) {
        if (this.closed) return false;
        if (error.code === 'OPTIONAL_GATT_DEFERRED' || error.name === 'AbortError') return false;
        this.error = error.message;
        return false;
      } finally {
        this.pending = false;
        if (!this.closed) this.changed(this);
      }
    }
    async run(operation) {
      if (root.SynapChakshu?.busy) throw Error('Finish the current capture first.');
      if (![1, 2, 3, 4].includes(operation) || !capabilities.isChakshu(this.module))
        throw Error('Connect Chakshu first.');
      if (this.pending || this.busy) throw Error('Wait for the current hardware check.');
      if (this.context.canUse?.() === false) throw Error(ERRORS[1]);
      if (!capabilities.hardwareCheck(this.module, operation))
        throw Error('This module does not support that hardware check.');
      this.pending = true;
      this.commandPending = true;
      this.error = '';
      this.path = '';
      this.changed(this);
      try {
        await this.updateStatus();
        if (this.status.state === 1) throw Error('A hardware check is already running on Chakshu.');
        const id = this.nextId;
        const characteristic = await this.characteristic(COMMAND);
        await this.context.queue(
          () => characteristic.writeValueWithResponse(new Uint8Array([0xc8, 1, operation, id])),
          'Start Chakshu hardware check',
        );
        this.ensure();
        // Keep the UI locked until a read confirms acceptance or failure.
        this.expected = { operation, id, deadline: Date.now() + 5000 };
        this.status = { ...this.status, operation, id, state: 1, progress: 0, error: 0, bytes: 0 };
        this.pathKey = '';
        this.error = '';
      } catch (error) {
        this.error = error.message;
        throw error;
      } finally {
        this.commandPending = false;
        this.pending = false;
        if (!this.closed) this.changed(this);
      }
    }
  }
  let client = null,
    timer = null;
  const notify = () => root.dispatchEvent?.(new CustomEvent('synap-module-changed'));
  function attach(context) {
    client?.close();
    client = new Client(context, notify);
    notify();
    schedule(250);
  }
  function schedule(delay = client?.busy ? 750 : !client?.available ? 1000 : 15000) {
    if (timer) root.clearTimeout(timer);
    timer = root.setTimeout(async () => {
      timer = null;
      if (!client) return;
      await client.refresh();
      if (client) schedule();
    }, delay);
  }
  root.addEventListener?.('synap-gatt-service-ready', (event) => attach(event.detail));
  root.addEventListener?.('synap-gatt-ready', () => {
    if (client) schedule(150);
  });
  root.addEventListener?.('synap-gatt-disconnected', () => {
    client?.close();
    client = null;
    if (timer) root.clearTimeout(timer);
    timer = null;
    notify();
  });
  const api = {
    UUID,
    FLAGS,
    PROFILES,
    decode,
    legacy,
    decodeStatus,
    Client,
    ERRORS,
    get client() {
      return client;
    },
    get busy() {
      return Boolean(client?.busy);
    },
    async refresh() {
      return client?.refresh();
    },
    async run(operation) {
      if (!client) throw Error('Connect Chakshu first.');
      const result = await client.run(operation);
      schedule(250);
      return result;
    },
  };
  root.SynapModules = api;
  if (root.SynapDevices?.connection) attach(root.SynapDevices.connection);
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
