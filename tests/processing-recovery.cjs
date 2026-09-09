'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'processing-recovery.js'), 'utf8');
const accountSource = fs.readFileSync(path.join(__dirname, '..', 'synap-account-ui.js'), 'utf8');
const taskSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'http', 'routes', 'tasks.ts'), 'utf8');

function flush() { return new Promise(resolve => setTimeout(resolve, 0)); }

function load(fetcher) {
  let now = 1_000_000;
  const intervals = [];
  const listeners = new Map();
  const context = {
    console,
    Date: class extends Date { static now() { return now; } },
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent() {},
    addEventListener(name, fn) { listeners.set(name, fn); },
    SynapAuth: { authedFetch: fetcher },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { ...context, _advance(ms) { now += ms; }, _tick() { intervals.forEach(fn => fn()); }, _listeners: listeners };
}

function response(state, progress = 0, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    async json() { return { state, progress }; },
  };
}

test('uploaded must remain stalled for 30 seconds before process-now is called', async () => {
  const calls = [];
  const context = load(async (url, options) => {
    calls.push([url, options]);
    if (String(url).endsWith('/process-now')) return response('uploaded');
    return response('uploaded', 0.1);
  });

  await context.SynapAuth.authedFetch('/v1/recordings/rec-1/processing');
  await flush();
  assert.equal(calls.some(call => String(call[0]).endsWith('/process-now')), false);

  context._advance(29_999);
  await context.SynapAuth.authedFetch('/v1/recordings/rec-1/processing');
  await flush();
  assert.equal(calls.some(call => String(call[0]).endsWith('/process-now')), false);

  context._advance(2);
  await context.SynapAuth.authedFetch('/v1/recordings/rec-1/processing');
  await flush();
  assert.equal(calls.some(call => String(call[0]).endsWith('/process-now')), true);
});

test('a recovery is rate limited and an advancing backend clears the stall', async () => {
  const calls = [];
  const context = load(async (url, options) => {
    calls.push([url, options]);
    if (String(url).endsWith('/process-now')) return response('transcribing', 0.05);
    return response('uploaded', 0.1);
  });

  await context.SynapAuth.authedFetch('/v1/recordings/rec-2/processing');
  context._advance(31_000);
  await context.SynapAuth.authedFetch('/v1/recordings/rec-2/processing');
  await flush();
  const afterFirst = calls.filter(call => String(call[0]).endsWith('/process-now')).length;
  assert.equal(afterFirst, 1);

  context._advance(5_000);
  await context.SynapAuth.authedFetch('/v1/recordings/rec-2/processing');
  await flush();
  assert.equal(calls.filter(call => String(call[0]).endsWith('/process-now')).length, 1);

  const entry = context.SynapProcessingRecovery._entries.get('rec-2');
  assert.equal(entry.lastState, 'uploaded');
});

test('the installed wrapper observes only recording processing status responses', async () => {
  const calls = [];
  const fetcher = async url => { calls.push(url); return response('uploaded', 0.1); };
  const context = load(fetcher);
  assert.notEqual(context.SynapAuth.authedFetch, fetcher);

  await context.SynapAuth.authedFetch('/v1/auth/me');
  await context.SynapAuth.authedFetch('/v1/recordings/rec-3/processing');
  await flush();

  assert.equal(calls.length, 2);
  assert.equal(context.SynapProcessingRecovery._entries.has('rec-3'), true);
});

test('the production shell loader and backend recovery endpoint remain wired', () => {
  assert.match(accountSource, /processing-recovery\.js\?v=1\.0\.0-recovery1/);
  assert.match(taskSource, /\/recordings\/:recordingId\/process-now/);
  assert.match(taskSource, /requireAuth\(\)/);
  assert.match(taskSource, /await processRecording\(\s*req\.uid,\s*recordingId,/s);
  assert.match(taskSource, /ACTIVE_STATES\.has\(recording\.state\)/);
});
