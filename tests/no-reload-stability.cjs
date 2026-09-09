'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const historySource = fs.readFileSync(path.join(root, 'cloud-history.js'), 'utf8');
const captureSource = fs.readFileSync(path.join(root, 'capture-stability.js'), 'utf8');
const pipelineSource = fs.readFileSync(path.join(root, 'processing-pipeline-ui.js'), 'utf8');
const transcriptRepairSource = fs.readFileSync(path.join(root, 'transcript-repair.js'), 'utf8');

function loadHistory() {
  const context = {
    console, Date, JSON, Error, Map, Set, Promise, Object, Array, String, Number,
    Boolean, Math, Intl, setTimeout, clearTimeout,
    document: { readyState: 'loading', addEventListener() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(historySource, context, { filename: 'cloud-history.js' });
  return context.SynapCloudHistory;
}

const history = loadHistory();
assert(history, 'cloud history API should load');
assert.equal(typeof history.meaningfullyChanged, 'function');
assert.equal(typeof history.restoreDay, 'function');
assert.equal(typeof history.restoreRecording, 'function');

const base = {
  id: 'r1', transcript: 'same', summary: 'same', processingState: 'done',
  restoredAt: '2026-09-09T00:00:00Z', processedAt: '2026-09-09T00:00:00Z'
};
const timestampOnly = Object.assign({}, base, {
  restoredAt: '2026-09-09T00:05:00Z', processedAt: '2026-09-09T00:05:00Z',
  processingUpdatedAt: '2026-09-09T00:05:00Z'
});
assert.equal(history.meaningfullyChanged(base, timestampOnly), false,
  'bookkeeping timestamps must not create a fake cloud-history change');
assert.equal(history.meaningfullyChanged(base, Object.assign({}, timestampOnly, { transcript: 'new text' })), true,
  'real transcript changes must still update local memory');

const historyCode = historySource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(historyCode, /location\s*\.\s*reload\s*\(/,
  'cloud sync must never reload the document because reload disconnects Web Bluetooth');
assert.doesNotMatch(historyCode, /addEventListener\s*\(\s*['"]visibilitychange['"]/,
  'cloud history must not refresh just because the app becomes visible');
assert.match(historySource, /datePicker/,
  'day changes should be an explicit cloud refresh trigger');
assert.match(historySource, /classList\.contains\('recording-card'\)/,
  'opening a recording should be an explicit targeted transcript trigger');
assert.match(historySource, /synap-memory-ready/,
  'a completed summary should immediately trigger the completed memory refresh');

const pipelineCode = pipelineSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(pipelineCode, /setInterval\s*\(/,
  'the processing pipeline must not wake up on a fixed timer');
assert.doesNotMatch(pipelineCode, /addEventListener\s*\(\s*['"]visibilitychange['"]/,
  'the processing pipeline must not refresh merely because the app foregrounds');
for (const event of ['synap-processing-state', 'synap-memory-ready', 'synap-cloud-history-updated']) {
  assert(pipelineSource.includes(event), `pipeline should refresh from ${event}`);
}

const repairCode = transcriptRepairSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(repairCode, /location\s*\.\s*reload\s*\(/,
  'manual transcript repair must update in place rather than refreshing the whole PWA');
assert.match(transcriptRepairSource, /recordingMemory/,
  'targeted recording memory fetch should be available for expand/transcript actions');
assert.match(transcriptRepairSource, /kind==='consolidate'/,
  'summary completion should emit a memory-ready event');

assert.doesNotMatch(captureSource, /\bconnect\s*\.\s*click\s*\(/,
  'capture stability must not run a second synthetic reconnect loop');
assert.doesNotMatch(captureSource, /start\s*\.\s*click\s*\(/,
  'capture stability must not create another recording after reconnect');
assert.match(captureSource, /beginTransportEpoch/,
  'sequence continuity remains available for a future same-recording transport resume');

console.log('PASS: Synap refresh is event-driven, in-place, BLE-safe and does not split recordings on reconnect.');
