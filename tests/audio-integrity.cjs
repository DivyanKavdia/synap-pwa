'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../audio-store.js');
const context = { document: null, DataView, Date };
vm.createContext(context);
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../audio-quality.js'), 'utf8'), context);
const quality = context.SynapAudioQuality;

test('missing audio is measured from absent frames, including partial frames', () => {
  const result = quality.gaps({ completeFrames: 259, missingFrames: 720, incompleteFrames: 2 }, 49050);
  assert.equal(result.missingMs, 36100);
  assert.equal(result.percent, 74);
  assert.equal(result.label, '36.1 s missing (74%)');
  assert.equal(quality.gaps({ completeFrames: 19, missingFrames: 1 }).label, '0.05 s missing (5%)');
});

test('captured silence never becomes a missing-audio warning', () => {
  const packets = [{ sequence: 0, chunk: 0, total: 1, payload: new Uint8Array(1600) }];
  const result = DKAudioCodec.assemble(packets, { preserveTimeline: true, startSequence: 0, endSequence: 0 });
  assert.equal(result.completeFrames, 1);
  assert.equal(result.missing, 0);
  assert.deepEqual(result.completeSequences, [0]);
  assert.equal(quality.gaps({ completeFrames: 1, missingFrames: 0, incompleteFrames: 0 }), null);
});

test('a recoverable window cannot be compacted while it still contains a hole', async () => {
  const store = new DKAudioStore();
  store.atomic = async () => { throw new Error('Incomplete rolling audio must not be mutated'); };
  for (const data of [
    { missing: 1, incomplete: 0, completeFrames: 599 },
    { missing: 0, incomplete: 1, completeFrames: 599 },
  ]) assert.equal(await store.compactSegment('recording', 0, data), false);
});
