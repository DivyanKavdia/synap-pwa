/* Device association is local to this PWA origin. IDs are public, not credentials. */
(function (root) {
  'use strict';
  const UUID = '4fa1234c-0000-1000-8000-00805f9b34fb';
  const KEY = 'synap-device-associations-v1';
  const validId = (value) =>
    typeof value === 'string' &&
    /^SYNAP-[0-9A-F]{12}$/.test(value) &&
    value !== 'SYNAP-000000000000' &&
    value !== 'SYNAP-FFFFFFFFFFFF';
  function decode(value) {
    if (!value || ![18, 19].includes(value.byteLength))
      throw Error('Invalid pendant device identifier.');
    const bytes = new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength);
    // Chakshu build 1227 sent its char[19] through NimBLE's generic overload.
    // Accept exactly that terminal NUL, then apply the same canonical ID checks.
    if (bytes.length === 19 && bytes[18] !== 0) throw Error('Invalid pendant device identifier.');
    const id = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 18));
    if (!validId(id)) throw Error('Invalid pendant device identifier.');
    return id;
  }
  let connection = null;
  async function discoverService(service, queue, assertConnection, options = {}) {
    const core = new Map(options.coreCharacteristics || []);
    function cachedService(inventory, audioOnly = false) {
      return Object.freeze({
        uuid: service.uuid,
        device: service.device,
        isPrimary: service.isPrimary,
        characteristicCount: inventory.size,
        audioOnly,
        async getCharacteristic(uuid) {
          assertConnection();
          const found = inventory.get(uuid.toLowerCase());
          if (found) return found;
          const error = new Error('This connection does not expose characteristic ' + uuid + '.');
          error.name = 'NotFoundError';
          throw error;
        },
      });
    }
    function useCore(error) {
      // These are native objects already discovered on THIS connection. Never
      // infer optional firmware support from the advertised device name.
      if (core.size !== 2 || [...core.values()].some((value) => !value)) throw error;
      options.onFallback?.(error);
      return cachedService(core, true);
    }
    if (options.audioOnly) {
      assertConnection();
      return useCore(
        new Error('Optional feature setup was unavailable on the previous connection.'),
      );
    }
    if (typeof service.getCharacteristics !== 'function') return service;
    let discovered;
    try {
      discovered = await queue(() => service.getCharacteristics(), 'Find pendant characteristics');
    } catch (error) {
      assertConnection();
      // A settled bridge failure need not discard usable audio/control handles.
      // A timeout is different: the native request may still be running, so the
      // app disconnects and can use core discovery on its next connection.
      if (options.allowAudioOnly && error?.name !== 'TimeoutError') return useCore(error);
      // A bridge may expose the method without implementing it. Only a settled,
      // explicit unsupported reply permits the older individual discovery path.
      if (error?.name === 'NotSupportedError') return service;
      throw error;
    }
    assertConnection();
    if (
      !Array.isArray(discovered) ||
      !discovered.length ||
      discovered.some((item) => typeof item?.uuid !== 'string' || !item.uuid) ||
      [...core.keys()].some((uuid) => !discovered.some((item) => item.uuid.toLowerCase() === uuid))
    ) {
      const error = Error('Pendant characteristic discovery was incomplete. Reconnect to retry.');
      if (options.allowAudioOnly) return useCore(error);
      throw error;
    }
    const inventory = new Map(discovered.map((item) => [item.uuid.toLowerCase(), item]));
    // Use a facade rather than modifying native objects. Absence in a complete
    // inventory is local NotFoundError, not another native request that an older
    // firmware/bridge combination can stall on. Rebuild for every connection.
    // Keep the handles on which the app installs notifications identical to
    // the ones exposed to other consumers, even if enumeration wraps them anew.
    for (const [uuid, characteristic] of core) inventory.set(uuid, characteristic);
    return cachedService(inventory);
  }
  function clearService() {
    connection = null;
    root.dispatchEvent?.(new CustomEvent('synap-gatt-disconnected'));
  }
  function publishService(
    service,
    queue,
    assertConnection,
    canUse = () => true,
    canUseMedia = () => false,
  ) {
    if (!service) return;
    function deferred() {
      const error = new Error('Optional Bluetooth setup deferred until recording stops.');
      error.name = 'AbortError';
      error.code = 'OPTIONAL_GATT_DEFERRED';
      return error;
    }
    const context = {
      service,
      canUse,
      canUseMedia,
      queue(action, label, options) {
        // Passive consumers must not occupy the queue during capture or recovery.
        if (!canUse()) return Promise.reject(deferred());
        return queue(
          async () => {
            assertConnection();
            if (connection !== context) throw Error('Pendant connection changed.');
            if (!canUse()) throw deferred();
            const value = await action();
            assertConnection();
            if (connection !== context) throw Error('Pendant connection changed.');
            return value;
          },
          label,
          options,
        );
      },
    };
    // Active camera capture uses the same serialized native queue, with an
    // explicit policy that permits audio streaming but excludes recovery/OTA.
    context.mediaQueue = (action, label, options) => {
      if (!canUseMedia()) return Promise.reject(deferred());
      return queue(
        async () => {
          assertConnection();
          if (connection !== context || !canUseMedia()) throw deferred();
          const value = await action();
          assertConnection();
          if (connection !== context) throw Error('Pendant connection changed.');
          return value;
        },
        label,
        options,
      );
    };
    connection = context;
    try {
      root.dispatchEvent(new CustomEvent('synap-gatt-service-ready', { detail: context }));
    } catch (_) {}
  }
  async function read(
    service,
    queue,
    assertConnection,
    canUse,
    canUseMedia,
    assertServiceConnection = assertConnection,
  ) {
    publishService(service, queue, assertServiceConnection, canUse, canUseMedia);
    let characteristic;
    try {
      characteristic = await queue(() => service.getCharacteristic(UUID), 'Find device identifier');
    } catch (error) {
      assertConnection();
      if (error.name === 'NotFoundError') return null;
      throw error;
    }
    assertConnection();
    const value = await queue(() => characteristic.readValue(), 'Read device identifier');
    assertConnection();
    const id = decode(value);
    if (connection?.service === service) connection.deviceId = id;
    root.dispatchEvent?.(new CustomEvent('synap-device-identified'));
    return id;
  }
  class Registry {
    constructor(
      storage,
      randomId = () => root.crypto.randomUUID(),
      now = () => new Date().toISOString(),
    ) {
      this.storage = storage;
      this.randomId = randomId;
      this.now = now;
    }
    load() {
      const raw = this.storage.getItem(KEY);
      if (!raw) return { schema: 1, installationId: null, devices: [] };
      const data = JSON.parse(raw);
      if (
        data.schema !== 1 ||
        typeof data.installationId !== 'string' ||
        !data.installationId ||
        !Array.isArray(data.devices) ||
        data.devices.some(
          (d) =>
            !validId(d.deviceId) ||
            typeof d.associationId !== 'string' ||
            !d.associationId ||
            !Array.isArray(d.bluetoothIds) ||
            !d.bluetoothIds.every((id) => typeof id === 'string' && id) ||
            typeof d.name !== 'string' ||
            typeof d.firstConnectedAt !== 'string' ||
            typeof d.lastConnectedAt !== 'string',
        ) ||
        new Set(data.devices.map((d) => d.deviceId)).size !== data.devices.length ||
        new Set(data.devices.flatMap((d) => d.bluetoothIds)).size !==
          data.devices.flatMap((d) => d.bluetoothIds).length
      ) {
        throw Error('Saved device associations could not be read.');
      }
      return data;
    }
    associate(deviceId, device) {
      if (!validId(deviceId) || !device || typeof device.id !== 'string' || !device.id)
        throw Error('Invalid device association.');
      const data = this.load();
      const previous = data.devices.find((d) => d.bluetoothIds.includes(device.id));
      if (previous && previous.deviceId !== deviceId) {
        const error = Error(
          'This Bluetooth connection reports a different device ID than the saved pendant. Connection stopped.',
        );
        error.code = 'DEVICE_ID_CHANGED';
        throw error;
      }
      const now = this.now();
      let record = data.devices.find((d) => d.deviceId === deviceId);
      if (!record) {
        record = {
          deviceId,
          associationId: this.randomId(),
          bluetoothIds: [],
          name: '',
          firstConnectedAt: now,
          lastConnectedAt: now,
        };
        data.devices.push(record);
      }
      if (!record.bluetoothIds.includes(device.id)) record.bluetoothIds.push(device.id);
      record.name = device.name || 'Synap pendant';
      record.lastConnectedAt = now;
      data.installationId ||= this.randomId();
      this.storage.setItem(KEY, JSON.stringify(data));
      return { ...record, installationId: data.installationId };
    }
  }
  root.SynapDevices = {
    UUID,
    KEY,
    decode,
    discoverService,
    read,
    Registry,
    publishService,
    clearService,
    get connection() {
      return connection;
    },
  };
  if (typeof module !== 'undefined') module.exports = root.SynapDevices;
})(globalThis);
