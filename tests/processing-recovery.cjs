const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'processing-recovery.js'), 'utf8');
const accountSource = fs.readFileSync(path.join(root, 'synap-account-ui.js'), 'utf8');
const taskSource = fs.readFileSync(path.join(root, 'backend/src/http/routes/tasks.ts'), 'utf8');

function load(fetcher) {
  const context = {
    console,
    Date,
    Map,
    Set,
    Promise,
    Number,
    String,
    Error,
    decodeURIComponent,
    encodeURIComponent,
    SynapAuth: { authedFetch: fetcher },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    clone() {
      return { json: async () => body };
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('uploaded must remain stalled for 30 seconds before process-now is called', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    return response({ state: 'ready' });
  };
  const context = load(fetcher);
  const recovery = context.SynapProcessingRecovery;

  recovery.observeState('rec-1', 'uploaded', fetcher, 1000);
  recovery.observeState('rec-1', 'uploaded', fetcher, 30999);
  await flush();
  assert.equal(calls.length, 0);

  recovery.observeState('rec-1', 'uploaded', fetcher, 31000);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/recordings/rec-1/process-now');
  assert.equal(calls[0].init.method, 'POST');
});

test('active backend stages are watched, and real stage progress resets the stall timer', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return response({ state: 'transcribing' }, true, 202);
  };
  const context = load(fetcher);
  const recovery = context.SynapProcessingRecovery;

  recovery.observeState('rec-active', 'uploaded', fetcher, 1000);
  recovery.observeState('rec-active', 'transcribing', fetcher, 20000);
  assert.equal(recovery._entries.get('rec-active').state, 'transcribing');
  assert.equal(recovery._entries.get('rec-active').since, 20000);

  // 30 seconds is measured from the latest backend stage change, not from upload.
  recovery.observeState('rec-active', 'transcribing', fetcher, 49999);
  await flush();
  assert.equal(calls.length, 0);

  recovery.observeState('rec-active', 'transcribing', fetcher, 50000);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], '/v1/recordings/rec-active/process-now');

  // A fresh active worker can legitimately answer 202. That is success for the
  // PWA safety-net; polling continues while the backend remains authoritative.
  assert.equal(recovery._entries.get('rec-active').inFlight, false);
});

test('a recovery is rate limited, stage changes reset the clock, and ready clears it', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return response({ state: 'ready' });
  };
  const context = load(fetcher);
  const recovery = context.SynapProcessingRecovery;

  recovery.observeState('rec-2', 'uploaded', fetcher, 1000);
  recovery.observeState('rec-2', 'uploaded', fetcher, 31000);
  await flush();
  recovery.observeState('rec-2', 'uploaded', fetcher, 45000);
  await flush();
  assert.equal(calls.length, 1, 'no recovery storm inside the 60 second retry window');

  recovery.observeState('rec-2', 'transcribing', fetcher, 46000);
  assert.equal(recovery._entries.get('rec-2').state, 'transcribing');
  recovery.observeState('rec-2', 'transcribing', fetcher, 75000);
  await flush();
  assert.equal(calls.length, 1, 'a new stage gets a fresh 30 second grace period');

  recovery.observeState('rec-2', 'ready', fetcher, 76000);
  assert.equal(recovery._entries.has('rec-2'), false);
});

test('the installed wrapper observes only recording processing status responses', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).includes('/processing')) return response({ state: 'uploaded' });
    return response({ ok: true });
  };
  const context = load(fetcher);
  assert.notEqual(context.SynapAuth.authedFetch, fetcher);

  await context.SynapAuth.authedFetch('/v1/auth/me');
  await context.SynapAuth.authedFetch('/v1/recordings/rec-3/processing');
  await flush();

  assert.equal(calls.length, 2);
  assert.equal(context.SynapProcessingRecovery._entries.has('rec-3'), true);
});

test('the PWA watches every recoverable cloud stage', () => {
  const recovery = load(async () => response({ state: 'ready' })).SynapProcessingRecovery;
  assert.deepEqual(Array.from(recovery.RECOVERABLE_STATES).sort(), ['indexing', 'transcribing', 'understanding', 'uploaded']);
});

test('the production shell and stale-active backend recovery remain wired', () => {
  assert.match(accountSource, /processing-recovery\.js\?v=1\.0\.0-recovery1/);
  assert.match(taskSource, /\/recordings\/:recordingId\/process-now/);
  assert.match(taskSource, /requireAuth\(\)/);
  assert.match(taskSource, /ACTIVE_STALE_MS\s*=\s*10\s*\*\s*60_000/);
  assert.match(taskSource, /isStaleActiveRecording/);
  assert.match(taskSource, /ACTIVE_STATES\.has\(recording\.state\)/);
  assert.match(taskSource, /state:\s*['"]uploaded['"]/);
  assert.match(taskSource, /await processRecording\(\s*req\.uid,\s*recordingId,/s);
});
