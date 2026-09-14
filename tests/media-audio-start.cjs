'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const source = app.slice(app.indexOf('  async function startMediaAudio()'), app.indexOf('  globalThis.SynapAppControls ='));
function harness(existing = false) {
  let time = 0, started = 0, stopped = [], receivedMs = 0;
  const c = {
    Promise, Error, Date: { now: () => time },
    appState: existing ? 'recording' : 'idle', recordingSessionId: existing ? 1 : 0,
    firmwareBusy: false, deviceStatus: { state: 2 }, sessionStats: {},
    log() {}, requireReady: () => true, requireAppOwnership: () => true, isGattConnected: () => true,
    isCurrentSession: id => id === c.recordingSessionId,
    recordingState: () => ({ active: c.appState === 'recording', receivedMs,
      sessionId: c.appState === 'recording' ? 'take:' + c.recordingSessionId : null }),
    startRecording: async () => { started++; c.recordingSessionId++; c.appState = 'recording'; },
    stopRecording: async () => { stopped.push(c.recordingSessionId); c.appState = 'idle'; },
    setTimeout: (fn, ms) => { time += ms; h.tick?.(time); fn(); },
  };
  const h = { c, tick: null, get started() { return started; }, stopped,
    get time() { return time; }, receive(ms = 50) { receivedMs = ms; } };
  vm.createContext(c); vm.runInContext(source, c);
  return h;
}
test('paired video waits for complete audio samples, not just STREAMING status', async () => {
  const h = harness();
  h.tick = time => { if (time >= 250) h.receive(); };
  const result = await h.c.startMediaAudio();
  assert.equal(result.receivedMs, 50);
  assert.equal(h.time, 250);
  assert.equal(h.started, 1);
  assert.deepEqual(h.stopped, []);
});
test('acknowledged but empty audio fails visibly and stops only the take it started', async () => {
  const h = harness();
  await assert.rejects(h.c.startMediaAudio(), /No audio samples arrived/);
  assert.equal(h.time, 10000);
  assert.deepEqual(h.stopped, [1]);
});
test('failed attachment leaves an existing audio take under its original owner', async () => {
  const h = harness(true);
  await assert.rejects(h.c.startMediaAudio(), /No audio samples arrived/);
  assert.equal(h.started, 0);
  assert.deepEqual(h.stopped, []);
});
test('cancelled media startup cannot stop or attach to a replacement recording', async () => {
  const h = harness();
  h.tick = () => { h.c.recordingSessionId++; h.receive(); };
  await assert.rejects(h.c.startMediaAudio(), /No audio samples arrived/);
  assert.deepEqual(h.stopped, []);
});
