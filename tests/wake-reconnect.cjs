'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const recovery = source.slice(source.indexOf('  const REMEMBERED_RECOVERY_INTERVAL_MS'), source.indexOf('  async function connectPendant('));

function setup({ watch = true, locked = false, preference = true } = {}) {
  let now = 100000, nextTimer = 0, calls = 0, connected = false, watchCalls = 0;
  const timers = new Map(), listeners = {}, saved = new Map([['dk-pendant-auto-reconnect', locked || !preference ? 'off' : 'on']]);
  const device = new EventTarget(); device.id = 'remembered'; device.name = 'synap';
  if (watch) device.watchAdvertisements = async ({ signal }) => { watchCalls++; device.signal = signal; };
  const checkbox = { checked: preference, addEventListener: (_, fn) => { listeners.preference = fn; } };
  const c = { WeakSet, AbortController, Promise, Math, Boolean, String,
    Date: class extends Date { static now() { return now; } },
    document: { visibilityState: 'visible', body: { dataset: locked ? { intentionalSleep: '1' } : {} },
      getElementById: id => id === 'autoReconnectInput' ? checkbox : {}, addEventListener: (name, fn) => { listeners[name] = fn; } },
    window: { isSecureContext: true, setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
      addEventListener: (name, fn) => { listeners[name] = fn; }, dispatchEvent() {} },
    navigator: { bluetooth: { getDevices: async () => [device], addEventListener() {} } },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    SynapSleepStateGuard: { locked, reconnectOnWake: preference },
    firmwareBusy: false, bluetoothDevice: device, manualDisconnect: false, connectInProgress: false, finalizing: false,
    currentRecordingId: null, recordingReconnectPending: false, reloadRecoveryRunning: false, lastReloadRecoveryAt: 0,
    reconnectTimer: null, reconnectAttempts: 8, MAX_AUTO_RECONNECT_ATTEMPTS: 8, connectionEpoch: 0,
    clearTimeout: id => timers.delete(id), isGattConnected: () => connected, withTimeout: promise => promise,
    log() {}, toast() {}, friendlyError: e => e.message, attachBluetoothDevice: d => { c.bluetoothDevice = d; },
    connectPendant: async options => { assert.equal(options.recoveryAttempt, true); calls++; }
  };
  vm.createContext(c); vm.runInContext(recovery, c); c.bindReconnectRecovery();
  return { c, device, timers, listeners, checkbox, saved, get calls() { return calls; }, get watches() { return watchCalls; },
    advance(ms) { now += ms; }, connected(value) { connected = value; },
    async tick() { const [id, timer] = timers.entries().next().value; timers.delete(id); now += timer.delay; await timer.fn(); },
    advertise(target = device) { const event = new Event('advertisementreceived'); event.device = target; device.dispatchEvent(event); }
  };
}

test('monitor retries after fast idle recovery is exhausted without resetting its budget', async () => {
  const t = setup({ watch: false });
  assert.equal(t.timers.size, 1);
  await t.tick(); await t.tick();
  assert.equal(t.calls, 2); assert.equal(t.c.reconnectAttempts, 8);
  assert.equal(t.timers.size, 1);
  assert.equal([...t.timers.values()][0].delay, 30000);
});

test('sleep preserves the user preference and permits a remembered wake probe', async () => {
  const t = setup({ locked: true });
  assert.equal(t.checkbox.checked, true);
  assert.equal(t.c.autoReconnectEnabled(), false, 'rapid retries remain disabled during sleep');
  await t.c.recoverRememberedConnection('page-load', true);
  assert.equal(t.calls, 1);
  assert.equal(t.c.SynapSleepStateGuard.locked, true, 'a failed probe does not clear sleep');
  const off = setup({ locked: true, preference: false });
  await off.c.recoverRememberedConnection('page-load', true);
  assert.equal(off.calls, 0); assert.equal(off.timers.size, 0);
});

test('advertisements trigger one recovery and ignore other devices and event bursts', async () => {
  const t = setup(); let release;
  t.c.connectPendant = () => new Promise(resolve => { release = resolve; });
  t.advertise({ id: 'other' }); assert.equal(release, undefined);
  t.advertise(); assert.equal(typeof release, 'function');
  const first = release; t.advertise(); assert.equal(release, first);
  assert.equal(t.watches, 1);
  release(); await Promise.resolve(); await Promise.resolve();
});

test('hidden, manual-disconnected and disabled states stop monitoring and stale advertisements', async () => {
  for (const state of ['hidden', 'manual', 'off']) {
    const t = setup(); const signal = t.device.signal;
    if (state === 'hidden') t.c.document.visibilityState = 'hidden';
    if (state === 'manual') t.c.manualDisconnect = true;
    if (state === 'off') t.saved.set('dk-pendant-auto-reconnect', 'off');
    t.c.syncRememberedMonitoring();
    assert(signal.aborted); assert.equal(t.timers.size, 0);
    t.advertise(); await t.c.recoverRememberedConnection('page-load', true);
    assert.equal(t.calls, 0);
  }
});

test('sleep transition has a grace period before any connection probe', async () => {
  const t = setup(); t.listeners['synap-intentional-sleep']({ detail: { active: true } });
  await t.c.recoverRememberedConnection('pendant-advertising', true);
  assert.equal(t.calls, 0);
  assert.equal([...t.timers.values()][0].delay, 5000);
  await t.tick(); assert.equal(t.calls, 1);
});

test('unsupported advertisement watching falls back to polling and stops on connection', async () => {
  const t = setup(); t.c.stopRememberedMonitoring();
  t.device.watchAdvertisements = () => Promise.reject(new Error('Not supported'));
  t.c.syncRememberedMonitoring(); await Promise.resolve();
  assert.equal(t.timers.size, 1);
  await t.tick(); assert.equal(t.calls, 1);
  t.connected(true); t.c.syncRememberedMonitoring(); assert.equal(t.timers.size, 0);
});
