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
    setTimeout,
    clearTimeout,
    AbortController,
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
  assert.ok(calls[0].init.signal, 'bounded recovery should pass an abort signal');
});

test('progress is a heartbeat and resets the stall timer inside one active stage', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return response({ state: 'transcribing', progress: 0.3 }, true, 202);
  };
  const recovery = load(fetcher).SynapProcessingRecovery;

  recovery.observeStatus('rec-active', { state: 'transcribing', progress: 0.10 }, fetcher, 1000);
  recovery.observeStatus('rec-active', { state: 'transcribing', progress: 0.20 }, fetcher, 20000);
  assert.equal(recovery._entries.get('rec-active').state, 'transcribing');
  assert.equal(recovery._entries.get('rec-active').progress, 0.2);
  assert.equal(recovery._entries.get('rec-active').since, 20000);

  recovery.observeStatus('rec-active', { state: 'transcribing', progress: 0.20 }, fetcher, 49999);
  await flush();
  assert.equal(calls.length, 0, 'moving transcription progress must not be treated as a stall');

  recovery.observeStatus('rec-active', { state: 'transcribing', progress: 0.20 }, fetcher, 50000);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], '/v1/recordings/rec-active/process-now');
  assert.equal(recovery._entries.get('rec-active').inFlight, false);
});

test('a recovery is rate limited, stage changes reset the clock, and ready clears it', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return response({ state: 'ready' });
  };
  const recovery = load(fetcher).SynapProcessingRecovery;

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

test('the installed wrapper observes state and progress only on processing status responses', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).includes('/processing')) return response({ state: 'transcribing', progress: 0.42 });
    return response({ ok: true });
  };
  const context = load(fetcher);
  assert.notEqual(context.SynapAuth.authedFetch, fetcher);

  await context.SynapAuth.authedFetch('/v1/auth/me');
  await context.SynapAuth.authedFetch('/v1/recordings/rec-3/processing');
  await flush();

  assert.equal(calls.length, 2);
  assert.equal(context.SynapProcessingRecovery._entries.get('rec-3').state, 'transcribing');
  assert.equal(context.SynapProcessingRecovery._entries.get('rec-3').progress, 0.42);
});

test('recovery calls are explicitly time bounded and always release the in-flight gate', () => {
  assert.match(source, /RECOVERY_REQUEST_TIMEOUT_MS\s*=\s*30000/);
  assert.match(source, /Promise\.race\(\[network, timeoutPromise\]\)/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /entry\.inFlight\s*=\s*false/);
});

test('the PWA watches every recoverable cloud stage', () => {
  const recovery = load(async () => response({ state: 'ready' })).SynapProcessingRecovery;
  assert.deepEqual(Array.from(recovery.RECOVERABLE_STATES).sort(), ['indexing', 'transcribing', 'understanding', 'uploaded']);
});

test('the production shell and stale-active backend recovery remain wired', () => {
  assert.match(accountSource, /processing-recovery\.js\?v=/);
  assert.match(taskSource, /\/recordings\/:recordingId\/process-now/);
  assert.match(taskSource, /requireAuth\(\)/);
  assert.match(taskSource, /ACTIVE_STALE_MS\s*=\s*10\s*\*\s*60_000/);
  assert.match(taskSource, /isStaleActiveRecording/);
  assert.match(taskSource, /ACTIVE_STATES\.has\(recording\.state\)/);
  assert.match(taskSource, /state:\s*['"]uploaded['"]/);
  assert.match(taskSource, /await processRecording\(\s*req\.uid,\s*recordingId,/s);
});