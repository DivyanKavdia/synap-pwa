'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const slice = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)));
function packet({ state = 2, error = 0, mtu = 23, chunks = 0, payload = 0 } = {}) {
  const v = new DataView(new ArrayBuffer(16));
  [0x5a, 2, state, error].forEach((n, i) => v.setUint8(i, n));
  v.setUint16(4, mtu, true); v.setUint16(6, mtu - 3, true);
  v.setUint8(8, chunks); v.setUint8(9, 8);
  v.setUint16(10, 16000, true); v.setUint16(12, 800, true); v.setUint16(14, payload, true);
  return v;
}
function harness({ initial = packet(), resuming = false, ackStop = true, delayedMtu = false, beforeRead, beforeStop } = {}) {
  let wire = initial, stopped = false;
  const commands = [], logs = [];
  const c = {
    Error, Promise, Uint8Array, Boolean, String, console,
    PROTOCOL_VERSION: 2, STATUS_MAGIC: 0x5a, AUDIO_HEADER_BYTES: 8, PCM_BYTES_PER_FRAME: 1600,
    DEFAULT_SAMPLE_RATE: 16000, MIN_STREAM_MTU: 32, MIN_CHUNKS_PER_FRAME: 1, MAX_CHUNKS_PER_FRAME: 20, MAX_AUDIO_PAYLOAD_BYTES: 500,
    CMD_STOP: 0, CMD_START: 1, CMD_GET_STATUS: 2, COMMAND_TIMEOUT_MS: 3500,
    DEVICE_STATE: { DISCONNECTED: 0, CONNECTED_IDLE: 1, STREAMING: 2, ERROR: 3 }, ERROR_TEXT: { 1: 'MTU too small' },
    SERVICE_UUID: 'service', AUDIO_CHAR_UUID: 'audio', CONTROL_CHAR_UUID: 'control',
    document: { body: { dataset: {} }, visibilityState: 'visible' }, navigator: { bluetooth: {} },
    ui: { settingsDialog: { open: false } }, localStorage: { setItem() {} },
    connectionEpoch: 0, connectInProgress: false, needsDeviceSelection: false, manualDisconnect: false,
    deviceStatus: { state: 0, error: 0 }, appState: 'disconnected', finalizing: false,
    recordingSessionId: 1, recordingConfirmed: resuming, recordingReconnectPending: resuming,
    recordingStopRequested: false, currentRecordingId: resuming ? 'owned-take' : null,
    recordingResumeDeviceId: null, recordingResumeBluetoothId: 'pendant', openingCapture: null,
    isCurrentSession: id => id === c.recordingSessionId, reconnectRequested: () => true,
    prepareRecordingTransportResume: async () => {}, completeRecordingTransportResume() { c.recordingReconnectPending = false; },
    isGattConnected: () => c.bluetoothDevice.gatt.connected, withTimeout: p => p,
    queueGattOperation: async action => action(), delay: async () => {},
    optionalGattAllowed: () => true, mediaGattAllowed: () => true,
    handleAudioNotification() {}, updateMetrics() {}, clearStartTimeout() {}, scheduleFinalize() {},
    confirmRecordingStarted() { c.confirmations = (c.confirmations || 0) + 1; },
    setAppState(state) { c.appState = state; }, toast() {}, log: (text, detail) => logs.push({ text, detail }),
    stopRememberedMonitoring() {}, syncRememberedMonitoring() {}, clearReconnectTimer() {},
    setReconnectCapability() {}, scheduleAutoReconnect() {}, renderDeviceSetup() {}, rememberDeviceAssociation() {},
    checkFirmwareRelease: null, friendlyError: e => e.message,
    cleanupCharacteristics() { c.connectionEpoch++; },
    disconnectGatt() { c.disconnects = (c.disconnects || 0) + 1; c.bluetoothDevice.gatt.connected = false; },
  };
  const control = {
    properties: { write: true }, addEventListener() {}, startNotifications: async () => {},
    async readValue() { beforeRead?.(c); return wire; },
    async writeValueWithResponse(bytes) {
      commands.push(bytes[0]);
      if (bytes[0] === 0) {
        beforeStop?.(c);
        if (ackStop) { stopped = true; wire = packet({ state: 1 }); }
      }
      if (bytes[0] === 2 && stopped) {
        wire = delayedMtu && !c.mtuRetried ? packet({ state: 3, error: 1 }) :
          packet({ state: 1, mtu: 517, chunks: 4, payload: 400 });
        c.mtuRetried = true;
      }
    },
  };
  const service = { getCharacteristic: async () => control };
  c.bluetoothDevice = { id: 'pendant', gatt: {
    connected: false, async connect() { this.connected = true; return this; }, getPrimaryService: async () => service,
  } };
  c.CustomEvent=class{constructor(type){this.type=type;}};(c.globalThis||c).dispatchEvent=()=>{};vm.createContext(c);
  vm.runInContext(slice('  async function connectPendant(', '  async function disconnectPendant(') +
    slice('  async function writeCommand(', '  // Recording lifecycle'), c);
  return { c, commands, logs, control, connect: () => c.connectPendant({ silent: true }) };
}
test('logged MTU 23 / zero-payload orphan is stopped and negotiated to PCM without disconnecting', async () => {
  const h = harness(); await h.connect();
  assert.equal(h.c.appState, 'idle'); assert.equal(h.c.disconnects || 0, 0);
  assert.deepEqual(h.commands, [2, 0, 2]);
  assert.equal(h.c.deviceStatus.mtu, 517); assert.equal(h.c.deviceStatus.audioTransport, 'pcm16');
  assert.equal(h.c.confirmations || 0, 0, 'invalid status must never confirm recording');
});
test('transport negotiation can finish after the old stream has acknowledged STOP', async () => {
  const h = harness({ delayedMtu: true }); await h.connect();
  assert.equal(h.c.appState, 'idle'); assert.equal(h.c.deviceStatus.mtu, 517);
  assert.deepEqual(h.commands, [2, 0, 2, 2]); assert.equal(h.c.disconnects || 0, 0);
});
test('owned interrupted recording is never stopped just because its transport is unconfigured', async () => {
  const h = harness({ resuming: true }); await h.connect();
  assert(!h.commands.includes(0)); assert(!h.commands.includes(1));
  assert.equal(h.c.currentRecordingId, 'owned-take'); assert.equal(h.c.recordingReconnectPending, true);
  assert.equal(h.c.confirmations || 0, 0);
});
test('malformed status cannot authorize stopping a pendant', async () => {
  for (const change of [v => v.setUint8(0, 0), v => v.setUint8(1, 99), v => v.setUint16(10, 8000, true)]) {
    const initial = packet(); change(initial); const h = harness({ initial }); await h.connect();
    assert(!h.commands.includes(0)); assert.equal(h.c.appState, 'disconnected');
  }
});
test('a write receipt without an idle status cannot declare the old stream stopped', async () => {
  const h = harness({ ackStop: false }); await h.connect();
  assert.equal(h.c.appState, 'disconnected'); assert.equal(h.commands.filter(n => n === 0).length, 1);
  assert(!h.commands.includes(1));
});
test('a late rejected status from a replaced connection cannot send STOP', async () => {
  const h = harness({ beforeRead: c => c.connectionEpoch++ }); await h.connect();
  assert(!h.commands.includes(0)); assert.equal(h.c.appState, 'disconnected');
});
