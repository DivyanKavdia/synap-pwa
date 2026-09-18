import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requireCompleteSegments,
  transcribeRecordingSegments,
  transcriptionBatches,
} from '../src/pipeline/recording-segments.js';
import type { SegmentDoc } from '../src/store/types.js';

const segment = (index: number, complete = false) =>
  ({
    index,
    startMs: index * 30_000,
    endMs: (index + 1) * 30_000,
    storagePath: `audio/${index}`,
    state: complete ? 'transcribed' : 'accepted',
    sealedTranscript: complete ? { ciphertext: 'text' } : null,
    sealedWords: complete ? { ciphertext: 'words' } : null,
  }) as unknown as SegmentDoc;

test('finalization requires every exact window, including a missing middle window', () => {
  for (const [segments, expected] of [
    [[], 1],
    [[segment(0)], 2],
    [[segment(0), segment(2)], 2],
    [[segment(0), segment(0)], 2],
    [[segment(0)], 0],
    [[{ ...segment(0), storagePath: null }], 1],
  ] as [SegmentDoc[], number][])
    assert.throws(() => requireCompleteSegments(segments, expected), /incomplete/);
  assert.deepEqual(
    requireCompleteSegments([segment(1), segment(0)], 2).map((s) => s.index),
    [0, 1],
  );
});

test('incomplete upload never starts transcription; completed windows are reused in order', async () => {
  let calls = 0;
  await assert.rejects(
    transcribeRecordingSegments(
      [segment(0)],
      2,
      async (s) => {
        calls++;
        return s;
      },
      async () => {},
    ),
    /incomplete/,
  );
  assert.equal(calls, 0);
  const progress: number[] = [];
  const result = await transcribeRecordingSegments(
    [segment(0, true), segment(1)],
    2,
    async (s) => {
      calls++;
      return segment(s.index, true);
    },
    async (done) => {
      progress.push(done);
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    result.map((s) => s.index),
    [0, 1],
  );
  assert.deepEqual(progress, [2]);
});

test('windows run one at a time and a quota failure stops before submitting the next audio', async () => {
  let active = 0, peak = 0;
  const calls: number[] = [], progress: number[] = [];
  await assert.rejects(transcribeRecordingSegments(
    Array.from({ length: 6 }, (_, i) => segment(i)), 6,
    async s => {
      active++; peak = Math.max(peak, active); calls.push(s.index);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (s.index === 1) throw Error('Quota cooldown');
      return segment(s.index, true);
    }, async done => { progress.push(done); },
  ), /Quota cooldown/);
  assert.equal(peak, 1);
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(progress, [1]);
  assert.equal(active, 0);
});


test('long-form ASR groups 30-second storage windows into 15-minute provider calls', () => {
  const all = Array.from({ length: 65 }, (_, index) => segment(index));
  const batches = transcriptionBatches(all, 15 * 60_000, () => true);
  assert.deepEqual(batches.map(batch => batch.length), [30, 30, 5]);
  assert(batches.every(batch => batch.at(-1)!.endMs - batch[0]!.startMs <= 15 * 60_000));

  // A completed window is a durable checkpoint and must split request groups;
  // a batch never retranscribes already-complete source just to stay large.
  const mixed = Array.from({ length: 65 }, (_, index) => segment(index, index === 30));
  const pending = transcriptionBatches(mixed, 15 * 60_000, item => item.state !== 'transcribed');
  assert.deepEqual(pending.map(batch => [batch[0]!.index, batch.at(-1)!.index]), [
    [0, 29],
    [31, 60],
    [61, 64],
  ]);
});
