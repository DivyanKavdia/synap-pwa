import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requireCompleteSegments,
  transcribeRecordingSegments,
} from '../src/pipeline/recording-segments.js';
import type { SegmentDoc } from '../src/store/types.js';

const segment = (index: number, complete = false) =>
  ({
    index,
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

test('a failed window waits for in-flight workers and prevents subsequent work or false completion', async () => {
  let release!: () => void,
    settled = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: number[] = [],
    progress: number[] = [];
  const run = transcribeRecordingSegments(
    Array.from({ length: 6 }, (_, i) => segment(i)),
    6,
    async (s) => {
      calls.push(s.index);
      if (s.index === 0) throw Error('Audio object missing');
      await pending;
      return segment(s.index, true);
    },
    async (done) => {
      progress.push(done);
    },
  );
  const failure = assert.rejects(run, /Audio object missing/).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'outstanding workers must settle before failure is published');
  assert.deepEqual(calls, [0, 1, 2, 3]);
  release();
  await failure;
  assert.deepEqual(progress, []);
});
