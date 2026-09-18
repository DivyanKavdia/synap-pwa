import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTranscriptionAudio } from '../src/gemini/transcription-audio.js';
import { transcribeSegment } from '../src/gemini/transcribe.js';
import { makePcm16Wav, parsePcm16Wav } from '../src/speaker/audio.js';

function tone(seconds = 6) {
  const pcm = Buffer.alloc(seconds * 32000);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(
      Math.round(9000 * Math.sin((2 * Math.PI * (i < 40000 ? 440 : 880) * i) / 16000)),
      i * 2,
    );
  return makePcm16Wav(pcm);
}
function frequency(pcm: Buffer, start: number, end: number) {
  let crossings = 0;
  for (let i = start + 1; i < end; i++)
    if (pcm.readInt16LE((i - 1) * 2) <= 0 && pcm.readInt16LE(i * 2) > 0) crossings++;
  return crossings / ((end - start) / 16000);
}
const response = (text: string, annotations: unknown[] = []) =>
  new Response(
    JSON.stringify({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text, annotations }] }],
    }),
  );

test('real atempo shortens PCM at 1.5x, keeps pitch and the tail, without changing the original', async () => {
  const source = tone(),
    before = Buffer.from(source);
  const result = await prepareTranscriptionAudio(source, 1.5);
  assert.equal(result.speed, 1.5, 'ffmpeg must be installed in the test and runtime images');
  assert.deepEqual(source, before);
  assert(Math.abs(result.durationMs - 4000) < 100);
  const pcm = parsePcm16Wav(result.audio).data;
  assert(Math.abs(frequency(pcm, 1600, 16000) - 440) < 5);
  assert(Math.abs(frequency(pcm, pcm.length / 2 - 3200, pcm.length / 2 - 320) - 880) < 10);
});

test('short speech windows and cancellation do not disappear', async () => {
  for (const seconds of [0.25, 3.3, 4.95]) {
    const source = tone(seconds);
    const result = await prepareTranscriptionAudio(source, 1.5);
    assert.deepEqual(result.audio, source);
    assert.equal(result.fallback, 'short-window');
  }
  await assert.rejects(prepareTranscriptionAudio(tone(), 1.5, AbortSignal.abort()));
});

test('ASR receives only the faster copy and word times return to the source timeline', async (t) => {
  const source = tone();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert(parsePcm16Wav(Buffer.from(body.input[0].data, 'base64')).data.length < 132000);
    return response('Hello', [
      { type: 'word_info', text: 'Hello', speaker: 'S1', start_offset: '0.4s', end_offset: '1s' },
    ]);
  });
  const result = await transcribeSegment(source, 'audio/wav', { speed: 1.5, baseOffsetMs: 30000 });
  assert.deepEqual(result.words, [
    { text: 'Hello', speaker: 'S1', start_ms: 30600, end_ms: 31500 },
  ]);
  assert.equal(result.audioUsage?.requestAttempts, 1);
  assert.equal(result.audioUsage?.policy, 'atempo-1.5-v1');
});

test('empty sped-up recognition retries the original once and accounts for both inputs', async (t) => {
  const source = tone();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (++calls === 1) return response('');
    assert.deepEqual(Buffer.from(JSON.parse(String(init?.body)).input[0].data, 'base64'), source);
    return response('कल मिलेंगे');
  });
  const result = await transcribeSegment(source, 'audio/wav', {
    speed: 1.5,
    diarize: false,
    wordTimestamps: false,
  });
  assert.equal(calls, 2);
  assert.match(result.text, /कल मिलेंगे/);
  assert.equal(result.audioUsage?.fallback, 'empty-recognition');
  assert.equal(result.audioUsage?.speed, 1);
  assert(result.audioUsage!.submittedAudioMs > 9900);
});

test('ordinary accelerated transcription pays for one input instead of a second annotation pass', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response('Complete text'); });
  const result = await transcribeSegment(tone(), 'audio/wav', { speed: 1.5 });
  assert.equal(calls, 1);
  assert.equal(result.audioUsage?.requestAttempts, 1);
  assert.equal(result.review.attempted, false);
  assert(Math.abs(result.audioUsage!.submittedAudioMs - 4000) < 100);
});

test('an ambiguous ASR transport failure is returned for a durable retry without more paid submissions', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('Response lost'); });
  await assert.rejects(transcribeSegment(tone(), 'audio/wav', { speed: 1.5 }), { status: 0, retryable: true });
  assert.equal(calls, 1);
});

test('a 3.3-second final window reaches ASR unchanged while the 30-second window is accelerated', async (t) => {
  const requests: Buffer[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requests.push(Buffer.from(JSON.parse(String(init?.body)).input[0].data, 'base64'));
    return response('Final words.');
  });
  const options = { speed: 1.5 as const, diarize: false, wordTimestamps: false };
  const full = await transcribeSegment(tone(30), 'audio/wav', options);
  const tail = tone(3.3);
  const result = await transcribeSegment(tail, 'audio/wav', { ...options, baseOffsetMs: 30000 });
  assert.equal(full.audioUsage?.speed, 1.5);
  assert(Math.abs(full.audioUsage!.preparedDurationMs - 20000) < 100);
  assert.deepEqual(requests[1], tail);
  assert.equal(result.audioUsage?.speed, 1);
  assert.equal(result.audioUsage?.fallback, 'short-window');
  assert.equal(result.text, '[00:30] S?: Final words.');
});

for (const failure of ['missing-text', 'incomplete', 'rejected'] as const) {
  test(`${failure} accelerated ASR recovers once with original bytes and original timestamps`, async (t) => {
    const source = tone(),
      before = Buffer.from(source),
      requests: any[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const original = Buffer.from(body.input[0].data, 'base64').equals(source);
      if (!original) {
        if (failure === 'rejected')
          return new Response('{"error":{"message":"Invalid argument"}}', { status: 400 });
        return new Response(
          JSON.stringify(
            failure === 'missing-text'
              ? { status: 'completed', steps: [] }
              : { status: 'incomplete', steps: [] },
          ),
        );
      }
      assert.deepEqual(body.generation_config.transcription_config, {});
      return response('Hello', [
        { type: 'word_info', text: 'Hello', speaker: 'S1', start_offset: '0.4s', end_offset: '1s' },
      ]);
    });
    const result = await transcribeSegment(source, 'audio/wav', {
      speed: 1.5,
      baseOffsetMs: 30000,
    });
    assert.equal(requests.length, failure === 'rejected' ? 3 : 2);
    assert.equal(result.audioUsage?.fallback, 'provider-failure');
    assert.equal(result.audioUsage?.requestAttempts, requests.length);
    assert.equal(result.audioUsage?.speed, 1);
    assert.deepEqual(result.words, [
      { text: 'Hello', speaker: 'S1', start_ms: 30400, end_ms: 31000 },
    ]);
    assert.deepEqual(source, before);
  });
}

test('repeated missing output fails after one original fallback and is never sealed as silence', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ status: 'completed', steps: [] }));
  });
  await assert.rejects(transcribeSegment(tone(), 'audio/wav', { speed: 1.5 }), {
    reason: 'missing-text',
    retryable: true,
  });
  assert.equal(calls, 2);
});

test('dedicated ASR quota rejection falls back once to Flash audio understanding', async (t) => {
  const source = tone();
  const requests: any[] = [];
  // Leave this synthetic cooldown far behind real wall-clock time after the test.
  t.mock.method(Date, 'now', () => 1_000_000);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (requests.length === 1) return new Response('{}', { status: 429 });
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.equal(body.input[0].type, 'text');
    assert.equal(body.input[1].type, 'audio');
    assert.deepEqual(Buffer.from(body.input[1].data, 'base64'), source);
    assert.equal('transcription_config' in body.generation_config, false);
    return response('Fallback transcript');
  });
  const result = await transcribeSegment(source, 'audio/wav', {
    speed: 1.5,
    enrichAnnotations: true,
    baseOffsetMs: 30000,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'gemini-3.5-transcribe');
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.equal(result.text, '[00:30] S?: Fallback transcript');
  assert.deepEqual(result.words, []);
  assert.equal(result.review.attempted, true);
  assert.equal(result.review.annotationsComplete, false);
  assert.equal(result.audioUsage?.requestAttempts, 2);
  assert.equal(result.audioUsage?.fallback, 'provider-failure');
  assert.equal(result.audioUsage?.speed, 1);
});

for (const status of [401, 403, 429, 503]) {
  test(`HTTP ${status} never resubmits the same model after a provider failure`, async (t) => {
    let calls = 0;
    const models: string[] = [];
    // Keep this fixture's shared-model cooldown in the past for later cases.
    if (status === 429) t.mock.method(Date, 'now', () => 2_000_000);
    t.mock.method(Math, 'random', () => 0);
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      calls++;
      models.push(JSON.parse(String(init?.body)).model);
      return new Response('{}', { status });
    });
    await assert.rejects(transcribeSegment(tone(), 'audio/wav', { speed: 1.5 }), { status });
    assert.equal(calls, status === 429 ? 2 : 1);
    assert.equal(models.filter(model => model === 'gemini-3.5-transcribe').length, 1);
    if (status === 429) assert.deepEqual(models, ['gemini-3.5-transcribe', 'gemini-3.8-flash']);
  });
}

test('cancellation between failed ASR and fallback cannot submit another request', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    controller.abort();
    return new Response(JSON.stringify({ status: 'completed', steps: [] }));
  });
  await assert.rejects(
    transcribeSegment(tone(), 'audio/wav', { speed: 1.5, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('exact digital silence makes no transcription request', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('unexpected upload');
  });
  const result = await transcribeSegment(makePcm16Wav(Buffer.alloc(96000)), 'audio/wav', {
    speed: 1.5,
  });
  assert.equal(result.audioUsage?.submittedAudioMs, 0);
  assert.equal(result.audioUsage?.requestAttempts, 0);
});
