import assert from 'node:assert/strict';
import test from 'node:test';
import { consecutiveSourceIds, MemoryMergeError, shiftTranscript } from '../src/pipeline/merge.js';

test('merge accepts only 2-5 consecutive canonical memories and restores chronology', () => {
  const available = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(consecutiveSourceIds(available, ['d', 'b', 'c']), ['b', 'c', 'd']);
  assert.throws(
    () => consecutiveSourceIds(available, ['a', 'c']),
    (error: unknown) => error instanceof MemoryMergeError && error.code === 'non_consecutive_memories',
  );
  assert.throws(() => consecutiveSourceIds(available, ['a']), /between 2 and 5/);
  assert.throws(() => consecutiveSourceIds(available, ['a', 'b', 'c', 'd', 'e', 'f']), /between 2 and 5/);
});

test('merged transcript timestamps preserve wall-clock gaps between recordings', () => {
  const input = '[00:05] S1: hello\n[01:09] S2: later';
  assert.equal(shiftTranscript(input, 60_000), '[01:05] S1: hello\n[02:09] S2: later');
  assert.equal(shiftTranscript('[59:59] S1: edge', 2_000), '[01:00:01] S1: edge');
});
