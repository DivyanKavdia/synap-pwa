// Dependency-free regression checks for capture continuity and cost UI.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');

function loadCaptureStability() {
  const appended = [];
  class Store {
    append(recordingId, packet) { appended.push({ recordingId, packet }); }
    async close() { return true; }
    async remove() { return true; }
  }
  const listeners = {};
  const ctx = {
    console, Map, Number, String, Object, Date, Promise,
    DKAudioStore: Store,
    document: { readyState: 'loading', addEventListener(type, fn) { listeners[type] = fn; } },
    setInterval() { throw new Error('journal patch should be immediate'); },
    clearInterval() {},
    globalThis: null
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'capture-stability.js'), 'utf8'), ctx);
  return { ctx, Store, appended };
}

async function captureTests() {
  const { ctx, Store, appended } = loadCaptureStability();
  const api = ctx.SynapCaptureStability;
  assert(api, 'capture stability API should be exposed');

  assert.equal(api.relativeSequence('a', 1200), 0);
  assert.equal(api.relativeSequence('a', 1201), 1);
  assert.equal(api.relativeSequence('b', 65534), 0);
  assert.equal(api.relativeSequence('b', 65535), 1);
  assert.equal(api.relativeSequence('b', 0), 2, '16-bit wrap must remain recording-relative');

  const store = new Store();
  store.append('take', { sequence: 32000, chunk: 0, total: 1, payload: new Uint8Array([1]) });
  store.append('take', { sequence: 32001, chunk: 0, total: 1, payload: new Uint8Array([2]) });
  assert.deepEqual(appended.map(x => x.packet.sequence), [0, 1], 'journal must never persist transport-global offsets');

  await store.close('take');
  store.append('take', { sequence: 500, chunk: 0, total: 1, payload: new Uint8Array([3]) });
  assert.equal(appended[2].packet.sequence, 0, 'a closed recording must get a fresh relative origin');
  assert.equal(Store.prototype.__synapRelativeSequencePatched, true);
}

function costTests() {
  const listeners = {};
  const ctx = {
    console, Number, String, Object, Date, Promise, Math, Map,
    document: { readyState: 'loading', addEventListener(type, fn) { listeners[type] = fn; } },
    globalThis: null
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'cost-ui.js'), 'utf8'), ctx);
  const api = ctx.SynapCostUI;
  assert(api, 'cost UI API should be exposed');

  const ready = api.estimate({
    durationMs: 60 * 60 * 1000,
    processingStage: 'ready',
    processingState: 'done',
    transcript: 'full transcript',
    summary: 'summary'
  });
  assert.equal(ready.minutes, 60);
  assert(Math.abs(ready.transcribeInr - 28.455) < 0.001);
  assert(ready.memoryInr > 0.79 && ready.memoryInr < 0.81, 'LLM memory extraction must be included');
  assert(ready.embeddingInr > 0.02 && ready.embeddingInr < 0.04, 'semantic indexing must be included');
  assert.equal(ready.llmProcessingInr, ready.memoryInr + ready.embeddingInr);
  assert(Math.abs(ready.totalInr - 29.28161775) < 0.001);
  assert.equal(api.money(ready.totalInr), '₹29.3');

  const unprocessed = api.estimate({ durationMs: 10 * 60 * 1000, processingStage: 'uploaded' });
  assert.equal(unprocessed.totalInr, 0);
  assert(unprocessed.projectedTranscribeInr > 4.7, 'projected transcription should be broken out');
  assert(unprocessed.projectedLlmProcessingInr > 0, 'projected LLM processing should be broken out');
  assert(unprocessed.projectedTotalInr > 4.87 && unprocessed.projectedTotalInr < 4.90);

  const source = fs.readFileSync(path.join(root, 'cost-ui.js'), 'utf8');
  assert(source.includes('Transcription'), 'expandable cost UI should name transcription');
  assert(source.includes('LLM processing'), 'expandable cost UI should name LLM processing');
  assert(source.includes('Gemini 3.5 Flash-Lite'), 'memory model should be transparent');
  assert(source.includes('Gemini Embedding 001'), 'indexing model should be transparent');
  assert(!/visibilitychange/.test(source), 'cost UI must remain event-driven and avoid foreground refresh loops');
}

function bootstrapTests() {
  const history = fs.readFileSync(path.join(root, 'cloud-history.js'), 'utf8');
  for (const file of ['capture-stability.js', 'recording-bridge.js', 'memory-tools.js', 'cost-ui.js']) {
    assert(history.includes(file), `cloud history bootstrap must load ${file}`);
  }
  assert(!history.includes('product-ui.js'), 'the removed Advanced & recovery product wrapper must not be reintroduced');

  const capture = fs.readFileSync(path.join(root, 'capture-stability.js'), 'utf8');
  assert(capture.includes('#advancedSettings,.product-advanced'));
  assert(capture.includes('#retrySaveButton,#recoveryButton,#runQueueButton,#pauseQueueButton'));
}

(async () => {
  await captureTests();
  costTests();
  bootstrapTests();
  console.log('PASS: capture continuity, transcript bootstrap and expandable INR AI cost breakdown checks.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
