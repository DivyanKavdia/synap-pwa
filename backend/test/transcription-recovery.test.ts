import assert from 'node:assert/strict';
import test from 'node:test';
import { transcribeSegment } from '../src/gemini/transcribe.js';
import { GeminiError, createInteraction } from '../src/gemini/client.js';
import { makePcm16Wav } from '../src/speaker/audio.js';

// Valid, non-silent audio so the tests exercise the provider request path.
const audio = makePcm16Wav(Buffer.alloc(32000, 16));
const invalidArgument = () => new Response(JSON.stringify({
  error: { message: 'Request contains an invalid argument.', code: 'invalid_request' },
}), { status: 400 });
const reply = (annotated = true) => new Response(JSON.stringify({
  status: 'completed',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Keep every word.',
    annotations: annotated ? ['Keep', 'every', 'word.'].map((text, i) => ({
      type: 'word_info', text, speaker: 'spk_1', start_offset: `${i}s`, end_offset: `${i + 1}s`,
    })) : [],
  }] }],
}));

test('ASR receives the exact complete source including quiet samples and leading/trailing silence', async () => {
  const originalFetch=fetch,pcm=Buffer.alloc(160000);
  for(let sample=32000;sample<48000;sample++)pcm.writeInt16LE(sample%2?1:-1,sample*2);
  const source=makePcm16Wav(pcm),before=Buffer.from(source);let calls=0;
  globalThis.fetch=async(_url,init)=>{
    const request=JSON.parse(String(init?.body));calls++;
    assert.deepEqual(Buffer.from(request.input[0].data,'base64'),before,'no crop, gain, filter or resampling before ASR');
    return calls===1?invalidArgument():reply();
  };
  try{
    const result=await transcribeSegment(source,'audio/wav',{language:'hi-IN',baseOffsetMs:30000});
    assert.equal(calls,2);assert.equal(result.words[0]?.start_ms,30000);
    assert.deepEqual(source,before);
  }finally{globalThis.fetch=originalFetch;}
});

test('legacy and free-form language preferences cannot enter the ASR request unchecked', async () => {
  for (const [language, expected] of [
    ['en', ['en-IN']], [' hi ', ['hi-IN']], ['EN_us', ['en-US']],
    ['fr', ['fr-FR']], ['Hinglish', undefined], ['English, Hindi', undefined],
    ['auto', undefined], ['zz-ZZ', undefined],
  ] as const) {
    const original = fetch;
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(request.generation_config.transcription_config.language_codes, expected);
      assert.equal(request.store, false);
      return reply();
    };
    try {
      const result = await transcribeSegment(audio, 'audio/wav', { language });
      assert.equal(calls, 1);
      assert.equal(result.review.annotationsComplete, true);
    } finally { globalThis.fetch = original; }
  }
});

test('a rejected language hint retries with automatic detection without timestamp constraints', async () => {
  const original = fetch;
  const requests: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    return request.generation_config.transcription_config.language_codes ? invalidArgument() : reply();
  };
  try {
    const result = await transcribeSegment(audio, 'audio/wav', { language: 'hi-IN', baseOffsetMs: 30000 });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].generation_config.transcription_config.mode, 'verbatim');
    assert.deepEqual(requests[1].input, requests[0].input);
    assert.ok(requests.every(request => request.store === false && !('usage_label' in request)));
    assert.equal(result.words[0]?.start_ms, 30000);
    assert.equal(result.review.annotationsComplete, true);
  } finally { globalThis.fetch = original; }
});

test('rejected mode recovers full text with provider defaults and no annotation charge', async () => {
  const original = fetch;
  const requests: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    return requests.length === 1 ? invalidArgument() : reply(false);
  };
  try {
    const result = await transcribeSegment(audio, 'audio/wav', { baseOffsetMs: 30000 });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].generation_config.transcription_config, {});
    assert.deepEqual(requests[1].input, requests[0].input);
    assert.equal(requests[1].store, false);
    assert.equal(result.text, '[00:30] S?: Keep every word.');
    assert.deepEqual(result.words, []);
    assert.deepEqual(result.speakers, []);
    assert.equal(result.review.annotationsComplete, false);
    assert.equal(result.review.attempted, false);
  } finally { globalThis.fetch = original; }
});

test('persistent invalid arguments stop after distinct configurations and identify the failing stage', async () => {
  for (const language of ['auto', 'hi-IN']) {
    const original = fetch;
    const configs: string[] = [];
    globalThis.fetch = async (_url, init) => {
      configs.push(JSON.stringify(JSON.parse(String(init?.body)).generation_config.transcription_config));
      return invalidArgument();
    };
    try {
      await assert.rejects(transcribeSegment(audio, 'audio/wav', { language }), (error: unknown) => {
        assert.ok(error instanceof GeminiError);
        assert.equal(error.status, 400);
        assert.equal(error.retryable, false);
        assert.match(error.message, /transcription.*gemini-3\.5-transcribe.*HTTP 400/);
        return true;
      });
      assert.equal(configs.length, language === 'auto' ? 2 : 3);
      assert.equal(new Set(configs).size, configs.length);
    } finally { globalThis.fetch = original; }
  }
});

test('a long dedicated-ASR cooldown falls back once to general audio understanding', async (t) => {
  const original = fetch;
  let calls = 0;
  t.mock.method(Date, 'now', () => 1000);
  globalThis.fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    if (calls === 1) {
      assert.equal(request.model, 'gemini-3.5-transcribe');
      return new Response(JSON.stringify({
        error: {
          details: [
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' },
          ],
        },
      }), { status: 429 });
    }
    assert.equal(request.model, 'gemini-3.8-flash');
    assert.equal(request.input[0].type, 'audio');
    assert.equal(request.input[1].type, 'text');
    assert.equal(request.generation_config.temperature, 0);
    assert.equal(request.generation_config.transcription_config, undefined);
    // Even if a general model unexpectedly emits word annotations, the
    // degraded fallback must discard them rather than claiming ASR diarization.
    return reply(true);
  };
  try {
    const result = await transcribeSegment(audio, 'audio/wav', {
      baseOffsetMs: 30000,
      enrichAnnotations: true,
    });
    assert.equal(calls, 2);
    assert.equal(result.model, 'gemini-3.8-flash');
    assert.equal(result.text, '[00:30] S?: Keep every word.');
    assert.deepEqual(result.words, []);
    assert.deepEqual(result.speakers, []);
    assert.equal(result.review.attempted, true);
    assert.equal(result.review.annotationsComplete, false);
  } finally { globalThis.fetch = original; }
});

test('a short dedicated-ASR rate limit waits instead of spending a fallback request', async (t) => {
  const original = fetch;
  let calls = 0;
  t.mock.method(Date, 'now', () => 1000);
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({
      error: {
        details: [
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '60s' },
        ],
      },
    }), { status: 429 });
  };
  try {
    await assert.rejects(transcribeSegment(audio, 'audio/wav'), (error: unknown) => {
      assert.ok(error instanceof GeminiError);
      assert.equal(error.status, 429);
      assert.equal(error.rateLimit?.retryAfterMs, 60000);
      return true;
    });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('a long ASR batch never falls back to flat text because timestamps are required for splitting', async (t) => {
  const original = fetch;
  let calls = 0;
  t.mock.method(Date, 'now', () => 1_000_000);
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({
      error: {
        details: [
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' },
        ],
      },
    }), { status: 429 });
  };
  try {
    await assert.rejects(
      transcribeSegment(audio, 'audio/wav', {
        primaryWordTimestamps: true,
        wordTimestamps: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GeminiError);
        assert.equal(error.status, 429);
        assert.equal(error.rateLimit?.retryAfterMs, 3600000);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('authentication failures and cancellation never start an alternate transcription request', async () => {
  for (const cancel of [false, true]) {
    const original = fetch;
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (cancel) controller.abort();
      return cancel ? invalidArgument() : new Response('{}', { status: 403 });
    };
    try {
      await assert.rejects(transcribeSegment(audio, 'audio/wav', { signal: controller.signal }),
        cancel ? { name: 'AbortError' } : { status: 403 });
      assert.equal(calls, 1);
    } finally { globalThis.fetch = original; }
  }
});

test('an invalid API key reported as HTTP 400 does not trigger option recovery', async () => {
  const original = fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'API key not valid.', status: 'INVALID_ARGUMENT' } }), { status: 400 });
  };
  try {
    await assert.rejects(transcribeSegment(audio, 'audio/wav'), { status: 400 });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('structured-memory errors identify their own stage without transcription fallback', async () => {
  const original = fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return invalidArgument(); };
  try {
    await assert.rejects(createInteraction({ model: 'gemini-3.5-flash', input: 'fixture', usage_label: 'memory_extract' }),
      /memory_extract.*gemini-3\.5-flash.*HTTP 400/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
