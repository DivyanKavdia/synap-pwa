// Dependency-free regression checks for capture continuity and cost UI.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');

async function captureTests() {
  require('../recording/timeline.js');
  require('../audio-store.js');
  const api = new SynapRecordingTimeline();
  assert.equal(api.relativeSequence('a', 1200), 0);
  assert.equal(api.relativeSequence('a', 1201), 1);
  assert.equal(api.relativeSequence('b', 65534), 0);
  assert.equal(api.relativeSequence('b', 65535), 1);
  assert.equal(api.relativeSequence('b', 0), 2);
  assert.equal(api.timelineOffsetMs('b'), 100);
  api.beginTransportEpoch('b', 20);
  assert.equal(api.relativeSequence('b', 0), 23);
  assert.equal(api.timelineOffsetMs('b'), 1150);
  const first = new DKAudioStore({timeline:new SynapRecordingTimeline()});
  const second = new DKAudioStore({timeline:new SynapRecordingTimeline()});
  for (const [store, sequence] of [[first,32000],[first,32001],[second,500]]) {
    store.append('same-id', {sequence,chunk:0,total:1,payload:new Uint8Array(1600)});
    clearTimeout(store.timer);
  }
  assert.deepEqual(first.buffer.map(p=>p.sequence), [0,1]);
  assert.deepEqual(second.buffer.map(p=>p.sequence), [0], 'separate store clocks cannot contaminate each other');
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
  const emptyDay=api.aggregate([]);
  assert.equal(emptyDay.minutes.toFixed(1),'0.0','empty-day breakdown must remain renderable');
  assert.equal(emptyDay.totalInr,0);
  assert.equal(emptyDay.projectedTotalInr,0);
  const local = api.estimate({localOnly:true,durationMs:60000,processingStage:'local'});
  assert.equal(local.totalInr,0);
  assert.equal(local.projectedTotalInr,0);
  assert.equal(local.embeddingTokens,0);

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
  const history = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const file of ['recording/timeline.js', 'recording-bridge.js', 'memory-tools.js', 'cost-ui.js']) {
    assert(history.includes(file), `production shell must load ${file}`);
  }
  assert(!fs.readFileSync(path.join(root, 'product-ui.js'), 'utf8').includes('Advanced & recovery'), 'the removed recovery wrapper must not be reintroduced');

  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert(styles.includes('#advancedSettings,.product-advanced'));
  assert(styles.includes('#retrySaveButton,#recoveryButton,#runQueueButton,#pauseQueueButton'));
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
