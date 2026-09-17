import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeSegment } from '../src/gemini/transcribe.js';
import { makePcm16Wav } from '../src/speaker/audio.js';
import { generateDek, sealJson, sealText } from '../src/crypto/envelope.js';
import { hasUsableTranscription } from '../src/pipeline/rolling-transcription.js';
import type { SegmentDoc } from '../src/store/types.js';

const audio = makePcm16Wav(Buffer.alloc(32000, 8));
const response = (text: string, status = 'completed', annotations: unknown[] = []) =>
  new Response(
    JSON.stringify({
      status,
      steps: [{ type: 'model_output', content: [{ type: 'text', text, annotations }] }],
    }),
  );

test('ordinary recognition submits audio once and preserves full mixed-language text without paid enrichment', async (t) => {
  const text = 'कल Friday को मिलेंगे। Budget -5% है, 5% नहीं।';
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    assert.deepEqual(Buffer.from(body.input[0].data, 'base64'), audio);
    return response(requests.length === 1 ? text : 'Friday. Budget 5%.');
  });
  const result = await transcribeSegment(audio, 'audio/wav');
  assert.deepEqual(requests[0].generation_config.transcription_config, { mode: 'verbatim' });
  assert.equal(requests.length, 1);
  assert.equal(result.text, '[00:00] S?: ' + text);
  assert.deepEqual(result.words, []);
  assert.equal(result.review.outcome, 'speech');
});

test('an empty result is retried once with automatic language before becoming no-speech', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls++;
    if (calls === 2)
      assert.deepEqual(body.generation_config.transcription_config, { mode: 'verbatim' });
    return response('');
  });
  const result = await transcribeSegment(audio, 'audio/wav', { language: 'hi-IN' });
  assert.equal(calls, 2);
  assert.equal(result.text, '');
  assert.equal(result.review.outcome, 'no-speech');
});

test('an initial empty result can recover real speech without losing it to annotations', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => response(++calls === 1 ? '' : 'Call tomorrow.'));
  const result = await transcribeSegment(audio, 'audio/wav', {
    diarize: false,
    wordTimestamps: false,
  });
  assert.equal(calls, 2);
  assert.equal(result.text, '[00:00] S?: Call tomorrow.');
  assert.equal(result.review.outcome, 'speech');
});

for (const status of ['incomplete', 'failed', 'cancelled', 'budget_exceeded'])
  test(status + ' provider output cannot be saved as a completed transcript', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => response('Only a partial sentence', status));
    await assert.rejects(transcribeSegment(audio, 'audio/wav'), { retryable: true });
  });

test('a missing text output is a retriable provider error, not silence', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ status: 'completed', steps: [] })),
  );
  await assert.rejects(transcribeSegment(audio, 'audio/wav'), { retryable: true });
});

test('legacy empty transcripts can retry, while valid speech and reviewed silence stay idempotent', () => {
  const dek = generateDek(),
    scope = 'recording/r/segment/0';
  const segment = {
    index: 0,
    state: 'transcribed',
    sealedTranscript: sealText(dek, '', { uid: 'u', scope, field: 'transcript' }),
    sealedWords: sealJson(dek, [], { uid: 'u', scope, field: 'words' }),
  } as SegmentDoc;
  assert.equal(hasUsableTranscription('u', 'r', dek, segment), false);
  assert.equal(
    hasUsableTranscription('u', 'r', dek, {
      ...segment,
      sealedTranscript: sealText(dek, 'Old complete speech', {
        uid: 'u',
        scope,
        field: 'transcript',
      }),
    }),
    true,
  );
  assert.equal(
    hasUsableTranscription('u', 'r', dek, {
      ...segment,
      transcriptionReview: {
        attempted: true,
        annotationsComplete: true,
        policy: 'text-first-v1',
        outcome: 'no-speech',
      },
    }),
    true,
  );
});
