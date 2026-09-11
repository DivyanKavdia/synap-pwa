/* Device association is local to this PWA origin. IDs are public, not credentials. */
(function (root) {
  'use strict';
  const UUID = '4fa1234c-0000-1000-8000-00805f9b34fb';
  const KEY = 'synap-device-associations-v1';
  const validId = value => typeof value === 'string' && /^SYNAP-[0-9A-F]{12}$/.test(value) &&
    value !== 'SYNAP-000000000000' && value !== 'SYNAP-FFFFFFFFFFFF';
  function decode(value) {
    if (!value || value.byteLength !== 18) throw Error('Invalid pendant device identifier.');
    const id = new TextDecoder('utf-8', { fatal: true }).decode(value);
    if (!validId(id)) throw Error('Invalid pendant device identifier.');
    return id;
  }
  let connection = null;
  function clearService() {
    connection = null;
    root.dispatchEvent?.(new CustomEvent('synap-gatt-disconnected'));
  }
  function publishService(service, queue, assertConnection) {
    if (!service) return;
    const context = { service, queue(action, label) {
      return queue(async () => {
        assertConnection();
        if (connection !== context) throw Error('Pendant connection changed.');
        const value = await action();
        assertConnection();
        if (connection !== context) throw Error('Pendant connection changed.');
        return value;
      }, label);
    } };
    connection = context;
    try { root.dispatchEvent(new CustomEvent('synap-gatt-service-ready', { detail: context })); }
    catch (_) {}
  }
  async function read(service, queue, assertConnection) {
    publishService(service, queue, assertConnection);
    let characteristic;
    try { characteristic = await queue(() => service.getCharacteristic(UUID), 'Find device identifier'); }
    catch (error) {
      assertConnection();
      if (error.name === 'NotFoundError') return null;
      throw error;
    }
    assertConnection();
    const value = await queue(() => characteristic.readValue(), 'Read device identifier');
    assertConnection();
    return decode(value);
  }
  class Registry {
    constructor(storage, randomId = () => root.crypto.randomUUID(), now = () => new Date().toISOString()) {
      this.storage = storage; this.randomId = randomId; this.now = now;
    }
    load() {
      const raw = this.storage.getItem(KEY);
      if (!raw) return { schema: 1, installationId: null, devices: [] };
      const data = JSON.parse(raw);
      if (data.schema !== 1 || typeof data.installationId !== 'string' || !data.installationId || !Array.isArray(data.devices) ||
          data.devices.some(d => !validId(d.deviceId) || typeof d.associationId !== 'string' || !d.associationId ||
            !Array.isArray(d.bluetoothIds) || !d.bluetoothIds.every(id => typeof id === 'string' && id) ||
            typeof d.name !== 'string' || typeof d.firstConnectedAt !== 'string' || typeof d.lastConnectedAt !== 'string') ||
          new Set(data.devices.map(d => d.deviceId)).size !== data.devices.length ||
          new Set(data.devices.flatMap(d => d.bluetoothIds)).size !== data.devices.flatMap(d => d.bluetoothIds).length) {
        throw Error('Saved device associations could not be read.');
      }
      return data;
    }
    associate(deviceId, device) {
      if (!validId(deviceId) || !device || typeof device.id !== 'string' || !device.id) throw Error('Invalid device association.');
      const data = this.load();
      const previous = data.devices.find(d => d.bluetoothIds.includes(device.id));
      if (previous && previous.deviceId !== deviceId) {
        const error = Error('This Bluetooth connection reports a different device ID than the saved pendant. Connection stopped.');
        error.code = 'DEVICE_ID_CHANGED'; throw error;
      }
      const now = this.now();
      let record = data.devices.find(d => d.deviceId === deviceId);
      if (!record) {
        record = { deviceId, associationId: this.randomId(), bluetoothIds: [], name: '', firstConnectedAt: now, lastConnectedAt: now };
        data.devices.push(record);
      }
      if (!record.bluetoothIds.includes(device.id)) record.bluetoothIds.push(device.id);
      record.name = device.name || 'Synap pendant'; record.lastConnectedAt = now;
      data.installationId ||= this.randomId();
      this.storage.setItem(KEY, JSON.stringify(data));
      return { ...record, installationId: data.installationId };
    }
  }
  root.SynapDevices = { UUID, KEY, decode, read, Registry, publishService, clearService, get connection() { return connection; } };
  if (typeof module !== 'undefined') module.exports = root.SynapDevices;
})(globalThis);
