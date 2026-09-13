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

function observeSamples(values, frames) {
  const pcm = new Int16Array(800);
  for (let i = 0; i < pcm.length; i++) pcm[i] = values[i % values.length];
  const bytes = new Uint8Array(pcm.buffer), before = bytes.slice();
  for (let frame = 0; frame < frames; frame++) quality.observe(bytes);
  assert.deepEqual(bytes, before, 'quality measurement never rewrites captured audio');
}

test('startup spikes cannot conceal later digital silence, and live warnings clear on speech', () => {
  quality.reset();
  observeSamples([32767, -32768], 4);
  observeSamples([-1, 0, 0, -1, 0], 120);
  let q = quality.snapshot();
  assert(q.rms > .003, 'the old lifetime average would miss this near-silent interval');
  assert.equal(q.longestNearSilentMs, 6000);
  assert.equal(q.recentSamples, 48000);
  assert(q.recentRms < .0001);
  assert.match(quality.describe(q)[0], /Almost no microphone signal for 6 s during/);
  assert.match(quality.describe(q, null, { live: true })[0], /Almost no microphone signal/);
  assert.equal(quality.gaps({ completeFrames: 124 }), null, 'received digital silence is never called a lost packet');
  observeSamples([600, -600], 60);
  q = quality.snapshot();
  assert.equal(q.nearSilentMs, 0);
  assert.equal(quality.describe(q, null, { live: true }).length, 0, 'recovered speech clears the live warning');
  assert.match(quality.describe(q)[0], /6 s during/, 'the saved take retains evidence of the earlier failure');
  quality.reset();
  assert.equal(quality.snapshot().longestNearSilentMs, 0);
  assert.equal(quality.snapshot().recentSamples, 0);
});

test('ordinary quiet audio and short pauses are not diagnosed as a missing microphone signal', () => {
  quality.reset();
  observeSamples([-40, 40], 60);
  assert.match(quality.describe(quality.snapshot())[0], /Very quiet audio/);
  observeSamples([0], 40);
  assert(!quality.describe(quality.snapshot()).some(text => text.includes('Almost no microphone')));
});
