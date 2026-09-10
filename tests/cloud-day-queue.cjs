'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'cloud-history.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  let signedIn = true, authListener, init;
  const requests = [], rows = new Map(), events = [];
  const body = { dataset: { state: 'idle' } };
  const picker = { value: '2026-09-10', dispatchEvent() {} };
  const context = {
    console: { warn() {} }, Date, JSON, Error, Map, Set, Promise, Object, Array, String, Number,
    Boolean, Math, Intl,
    SYNAP_STATIC_BOOTSTRAP: true,
    document: {
      readyState: 'loading', body,
      getElementById: id => id === 'datePicker' ? picker : null,
      addEventListener(name, callback) { if (name === 'DOMContentLoaded') init = callback; }
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    SynapAuth: { isSignedIn: () => signedIn, onChange: callback => { authListener = callback; } },
    SynapBackend: {
      recordings(options) {
        return new Promise((resolve, reject) => requests.push({ options, resolve, reject }));
      }
    },
    DKAudioStore: class {
      open() { return Promise.resolve(this); }
      all() { return Promise.resolve([...rows.values()]); }
      atomic(names, write) {
        write({ recordings: { put: row => rows.set(row.id, row) } });
        return Promise.resolve();
      }
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    dispatchEvent: event => events.push(event),
    addEventListener() {}
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'cloud-history.js' });
  return {
    api: context.SynapCloudHistory, requests, rows, events, body, picker,
    setSignedIn(value, notify = false) { signedIn = value; if (notify) authListener?.(value ? { refreshToken: 'session' } : null); },
    bindAuth() { signedIn = false; init(); signedIn = true; },
    finish(index, recordingId) {
      requests[index].resolve({ recordings: recordingId ? [{ recording_id: recordingId, started_at: requests[index].options.day + 'T12:00:00Z', state: 'uploaded' }] : [] });
    }
  };
}

test('rapid navigation hydrates the latest queued day and reports replaced requests as superseded', async () => {
  const h = setup();
  const first = h.api.restoreDay('2026-09-08');
  await tick();
  const replaced = h.api.restoreDay('2026-09-09');
  const latest = h.api.restoreDay('2026-09-10');
  const duplicate = h.api.restoreDay('2026-09-10');
  assert.equal(latest, duplicate, 'same pending day shares its result');
  const skipped = await replaced;
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.superseded, true);
  assert.equal(skipped.day, '2026-09-09');
  assert.equal(h.requests.length, 1);
  h.finish(0);
  await first;
  await tick();
  assert.deepEqual(h.requests.map(request => request.options.day), ['2026-09-08', '2026-09-10']);
  assert.equal(h.requests[1].options.transcript, false);
  h.finish(1, 'today-conversation');
  const result = await latest;
  assert.equal(result.restored, 1);
  assert(h.rows.has('today-conversation'));
  assert.equal(h.events.filter(event => event.type === 'synap-cloud-history-updated').length, 1);
});

test('a direct weekly restore completion drains the latest selected day', async () => {
  const h = setup();
  const weekly = h.api.restore(true, { day: '2026-09-07', transcript: false });
  await tick();
  const selected = h.api.restoreDay('2026-09-10');
  h.finish(0);
  await weekly;
  await tick();
  assert.deepEqual(h.requests.map(request => request.options.day), ['2026-09-07', '2026-09-10']);
  h.finish(1);
  assert.equal((await selected).skipped, undefined);
});

test('returning to the active day cancels the queued detour without another fetch', async () => {
  const h = setup();
  const active = h.api.restoreDay('2026-09-10');
  await tick();
  const detour = h.api.restoreDay('2026-09-09');
  const returned = h.api.restoreDay('2026-09-10');
  assert.equal(returned, active);
  assert.equal((await detour).superseded, true);
  h.finish(0);
  await active;
  await tick();
  assert.equal(h.requests.length, 1);
});

test('a failed restore releases the queued day without automatically retrying the failed day', async () => {
  const h = setup();
  const first = h.api.restore(true, { day: '2026-09-07', transcript: false });
  await tick();
  const selected = h.api.restoreDay('2026-09-10');
  h.requests[0].reject(new Error('Temporary network failure'));
  assert.match((await first).error.message, /Temporary network failure/);
  await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].options.day, '2026-09-10');
  h.finish(1);
  await selected;
  await tick();
  assert.equal(h.requests.length, 2);
});

test('capture beginning before drain skips queued hydration and requires a fresh idle request', async () => {
  const h = setup();
  const first = h.api.restoreDay('2026-09-09');
  await tick();
  const selected = h.api.restoreDay('2026-09-10');
  h.body.dataset.state = 'recording';
  h.finish(0);
  await first;
  const skipped = await selected;
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'capture-busy');
  assert.equal(h.requests.length, 1);
  h.body.dataset.state = 'idle';
  await tick();
  assert.equal(h.requests.length, 1, 'no background retry timer');
  const retry = h.api.restoreDay('2026-09-10');
  await tick();
  assert.equal(h.requests.length, 2);
  h.finish(1);
  await retry;
});

test('sign-out clears a queued day and no request drains under a missing session', async () => {
  const h = setup();
  h.bindAuth();
  const first = h.api.restoreDay('2026-09-09');
  await tick();
  const selected = h.api.restoreDay('2026-09-10');
  h.setSignedIn(false, true);
  const skipped = await selected;
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'signed-out');
  h.finish(0);
  await first;
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal((await h.api.restoreDay('2026-09-10')).reason, 'signed-out');
});

test('signing back in on the active day fetches a new session result and discards the old response', async () => {
  const h = setup();
  h.bindAuth();
  const oldSession = h.api.restoreDay('2026-09-10');
  await tick();
  h.setSignedIn(false, true);
  h.setSignedIn(true, true);
  const newSession = h.api.restoreDay('2026-09-10');
  assert.notEqual(newSession, oldSession, 'the signed-out request cannot satisfy a new session');
  h.finish(0, 'old-account-memory');
  assert.equal((await oldSession).skipped, true);
  await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.rows.has('old-account-memory'), false);
  h.finish(1, 'new-account-memory');
  assert.equal((await newSession).restored, 1);
  assert(h.rows.has('new-account-memory'));
});
