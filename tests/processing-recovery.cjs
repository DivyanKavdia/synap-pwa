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

test('a recovery is rate limited and an advancing backend clears the stall', async () => {
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
  assert.equal(recovery._entries.has('rec-2'), false);
  recovery.observeState('rec-2', 'uploaded', fetcher, 47000);
  recovery.observeState('rec-2', 'uploaded', fetcher, 76000);
  await flush();
  assert.equal(calls.length, 1, 'a fresh uploaded observation gets a fresh 30 second grace period');
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

test('the production shell loader and backend recovery endpoint remain wired', () => {
  assert.match(accountSource, /processing-recovery\.js\?v=1\.0\.0-recovery1/);
  assert.match(taskSource, /\/recordings\/:recordingId\/process-now/);
  assert.match(taskSource, /requireAuth\(\)/);
  assert.match(taskSource, /await processRecording\(req\.uid, recordingId\)/);
  assert.match(taskSource, /ACTIVE_STATES\.has\(recording\.state\)/);
});
