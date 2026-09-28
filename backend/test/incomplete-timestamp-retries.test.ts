import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiError, modelFailure } from '../src/gemini/client.js';
import {
  INCOMPLETE_TIMESTAMP_ATTEMPTS,
  timestampsExhausted,
} from '../src/pipeline/process.js';
import { shareTextByDuration } from '../src/pipeline/rolling-transcription.js';
import { timestampAnnotationsComplete } from '../src/gemini/transcribe.js';
import type { RecordingDoc, SegmentDoc } from '../src/store/types.js';

const recordingWith = (
  failure: RecordingDoc['processingFailure'],
): RecordingDoc => ({ processingFailure: failure } as RecordingDoc);

const incomplete = modelFailure(new GeminiError('x', 0, true, 'incomplete'));

test('a model_incomplete streak stops being retried once it is clearly deterministic', () => {
  assert.equal(incomplete.code, 'model_incomplete');
  assert.equal(incomplete.retryable, true, 'one bad response is still worth retrying');

  // Below the threshold the pipeline keeps asking for real word timestamps.
  for (let attempts = 0; attempts < INCOMPLETE_TIMESTAMP_ATTEMPTS; attempts++) {
    assert.equal(
      timestampsExhausted(recordingWith({ ...incomplete, attempts })),
      false,
      `attempt ${attempts} must still demand timestamps`,
    );
  }
  // At the threshold it accepts text alone, which is what ends the loop that
  // was re-billing the same failing request every two minutes.
  assert.equal(
    timestampsExhausted(recordingWith({ ...incomplete, attempts: INCOMPLETE_TIMESTAMP_ATTEMPTS })),
    true,
  );
});

test('only a repeating timestamp failure relaxes; other failures never do', () => {
  const rateLimited = modelFailure(new GeminiError('x', 429, true, 'request'));
  assert.equal(
    timestampsExhausted(recordingWith({ ...rateLimited, attempts: 99 })),
    false,
    'a rate limit is transient however often it repeats, and must keep full fidelity',
  );
  assert.equal(timestampsExhausted(recordingWith(null)), false);
  assert.equal(timestampsExhausted(recordingWith(undefined)), false);
  // A failure whose code changed restarts the streak, so an unrelated blip in
  // the middle of a run cannot push an otherwise healthy recording over.
  assert.equal(timestampsExhausted(recordingWith({ ...incomplete })), false);
});

test('the completeness check really is all-or-nothing, which is why the loop never converged', () => {
  const words = [
    { text: 'hello', start_ms: 0, end_ms: 400 },
    { text: 'there', start_ms: 400, end_ms: 800 },
  ];
  assert.equal(timestampAnnotationsComplete('hello there', words as never), true);
  // One zero-duration token fails the whole batch.
  assert.equal(
    timestampAnnotationsComplete('hello there', [
      words[0]!,
      { text: 'there', start_ms: 400, end_ms: 400 },
    ] as never),
    false,
  );
  // So does one word the annotations dropped.
  assert.equal(timestampAnnotationsComplete('hello there friend', words as never), false);
});

const segment = (index: number, startMs: number, endMs: number) =>
  ({ index, startMs, endMs } as SegmentDoc);

test('a degraded transcript is shared across windows without losing a word', () => {
  const segments = [segment(0, 0, 30_000), segment(1, 30_000, 60_000), segment(2, 60_000, 90_000)];
  const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
  const shares = shareTextByDuration(`[00:00] S?: ${words.join(' ')}`, segments);

  const rejoined = segments.flatMap(s => shares.get(s.index)!.split(/\s+/u).filter(Boolean));
  assert.deepEqual(rejoined, words, 'every token survives, in order');
  // Equal windows, so an equal share each.
  for (const s of segments) assert.equal(shares.get(s.index)!.split(' ').length, 10);
});

test('sharing follows duration, not window count', () => {
  // A half-length final window should receive proportionally less text.
  const segments = [segment(0, 0, 30_000), segment(1, 30_000, 45_000)];
  const shares = shareTextByDuration('a b c d e f', segments);
  assert.equal(shares.get(0), 'a b c d');
  assert.equal(shares.get(1), 'e f');
});

test('sharing is total and safe at the edges', () => {
  const segments = [segment(0, 0, 30_000), segment(1, 30_000, 60_000)];
  // Silence produces empty windows rather than throwing.
  for (const s of segments) assert.equal(shareTextByDuration('', segments).get(s.index), '');
  assert.equal(shareTextByDuration('[00:00] S?:   ', segments).get(0), '');

  // Fewer tokens than windows must not duplicate a token or drop it.
  const sparse = shareTextByDuration('only', segments);
  assert.equal([sparse.get(0), sparse.get(1)].filter(Boolean).join(' '), 'only');

  // A zero-length window cannot take a negative share.
  const degenerate = shareTextByDuration('a b', [segment(0, 0, 0), segment(1, 0, 30_000)]);
  assert.equal([degenerate.get(0), degenerate.get(1)].join(' ').trim().split(/\s+/u).length, 2);

  assert.equal(shareTextByDuration('a b', []).size, 0);
});
