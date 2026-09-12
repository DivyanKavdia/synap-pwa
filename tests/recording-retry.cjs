'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

async function queueTargetsOnlySelectedRecording() {
  const context = {
    console,
    Blob,
    FormData,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    globalThis: null,
    navigator: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(read('audio-store.js'), context);
  vm.runInContext(read('processing-queue.js'), context);

  const patches = [];
  const store = {
    async all(storeName, index, key) {
      if (storeName === 'jobs' && index === 'recording' && key === 'target') {
        return [
          { id: 11, recordingId: 'target', state: 'failed', attempts: 5, lastError: 'boom', startedAt: 123 },
          { id: 12, recordingId: 'target', state: 'pending', attempts: 0 },
        ];
      }
      if (storeName === 'jobs' && index === 'recording' && key === 'other') {
        return [{ id: 21, recordingId: 'other', state: 'failed', attempts: 5 }];
      }
      return [];
    },
    async patchJob(id, fields) { patches.push({ id, fields }); return true; },
  };

  const processor = new context.DKFIFOProcessor(store, {
    settings: () => ({}),
    canRun: () => false,
  });
  await processor.retryRecording('target');

  assert.deepEqual(patches.map(item => item.id), [11], 'retry must reset only the failed job for the selected recording');
  assert.equal(patches[0].fields.state, 'pending');
  assert.equal(patches[0].fields.attempts, 0);
  assert.equal(patches[0].fields.nextAt, 0);
  assert.equal(patches[0].fields.lastError, '');
  assert.equal(patches[0].fields.startedAt, null, 'stale running metadata must be cleared before retry');
  assert.equal(patches[0].fields.finishedAt, null, 'stale completion metadata must be cleared before retry');
  assert.equal(typeof context.SynapProcessingQueue.retryRecording, 'function');
}

function uiAndBackendContract() {
  const pipeline = read('processing-pipeline-ui.js');
  assert.match(pipeline, /Retry processing/, 'expanded failed pipeline must offer Retry processing');
  assert.match(pipeline, /recording-pipeline-retry/, 'collapsed Needs retry badge must be actionable');
  assert.match(pipeline, /retryRecording\(recording, status\)/, 'collapsed retry must target its own recording');
  assert.doesNotMatch(pipeline, /Use Process queue to retry\./, 'removed global queue control must never be referenced in product copy');

  const backendClient = read('synap-backend.js');
  assert.match(backendClient, /retryRecording:function\(recordingId\)/);
  assert.match(backendClient, /\/retry'/);
  assert.match(backendClient, /Idempotency-Key/);

  const retryRoute = read('backend/src/http/routes/retry.ts');
  assert.match(retryRoute, /ACTIVE_STATES/, 'retry route must recognize a cloud worker that already resumed');
  assert.match(retryRoute, /UPLOAD_STATES/, 'retry route must let local upload recovery continue without a false 409');
  assert.match(retryRoute, /already_processing:\s*true/, 'active cloud work must be treated as a successful retry convergence');
  assert.match(retryRoute, /awaiting_upload:\s*true/, 'created\/uploading cloud state must let the local queue resend missing work');
  assert.match(retryRoute, /recording\.state !== 'failed'\s*&&\s*recording\.state !== 'uploaded'/,
    'uploaded and retryable failed recordings must both be eligible for a fresh cloud task');
  assert.match(retryRoute, /recording\.state === 'failed'\s*&&\s*!recording\.retryable/,
    'a truly non-retryable failed recording must stay blocked');
  assert.match(retryRoute, /enqueueProcessing\(req\.uid, recordingId, taskSuffix\)/,
    'retry must enqueue a unique processing task when cloud work needs restarting');
  assert.match(retryRoute, /state: 'failed'[\s\S]*retryable: true/, 'queue dispatch failure must remain retryable');

  const app = read('backend/src/http/app.ts');
  assert(app.indexOf("app.use('/v1', retryRoutes())") < app.indexOf("app.use('/v1', recordingRoutes())"),
    'route-scoped retry must be mounted before blanket-auth recording router');

  const queue = read('backend/src/pipeline/queue.ts');
  assert.match(queue, /taskSuffix\?: string/);
  assert.match(queue, /taskSuffix \|\| normalSuffix/);
}

(async () => {
  await queueTargetsOnlySelectedRecording();
  uiAndBackendContract();
  console.log('PASS: Needs retry converges stale local and cloud states and retries only the selected recording.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
