import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteraction, GeminiError, modelFailure } from '../src/gemini/client.js';
import { ModelCooldowns, rateLimitAdvice } from '../src/gemini/rate-limit.js';

const details = (...entries: unknown[]) =>
  JSON.stringify({ error: { message: 'PRIVATE INPUT KEY', details: entries } });
const retry = (retryDelay: unknown) => ({
  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
  retryDelay,
});
const quota = (quotaId: string) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaId }],
});

test('429 advice honors the longest provider delay and defaults safely for missing details', () => {
  const now = Date.parse('2026-09-17T00:00:00Z');
  assert.deepEqual(rateLimitAdvice(null, '{}'), { quotaKind: 'unknown', retryAfterMs: 60000 });
  assert.equal(rateLimitAdvice('120', 'not JSON').retryAfterMs, 120000);
  assert.equal(rateLimitAdvice('Thu, 17 Sep 2026 00:02:30 GMT', '{}', now).retryAfterMs, 150000);
  assert.equal(rateLimitAdvice('120', details(retry('180.25s'))).retryAfterMs, 180250);
  assert.equal(
    rateLimitAdvice('240', details(retry({ seconds: '180', nanos: 500000000 }))).retryAfterMs,
    240000,
  );
  assert.equal(
    rateLimitAdvice(null, details(retry({ seconds: '180', nanos: 500000000 }))).retryAfterMs,
    180500,
  );
  for (const delay of ['NaNs', '-1s', {}, null]) {
    assert.equal(rateLimitAdvice('invalid', details(retry(delay))).retryAfterMs, 60000);
  }
  assert.equal(rateLimitAdvice('999999999999', '{}').retryAfterMs, 604800000);
});

test('daily quota classification requires structured quota evidence and never exposes provider text', () => {
  const daily = rateLimitAdvice(
    '120',
    details(quota('GenerateRequestsPerDayPerProjectPerModel'), quota('RequestsPerMinute')),
  );
  assert.deepEqual(daily, { quotaKind: 'daily', retryAfterMs: 3600000 });
  assert.equal(rateLimitAdvice(null, details(quota('requests_per_minute'))).quotaKind, 'rate');
  assert.equal(
    rateLimitAdvice(null, '{"error":{"message":"daily quota exceeded"}}').quotaKind,
    'unknown',
  );
  const safe = modelFailure(new GeminiError('PRIVATE INPUT KEY', 429, true, 'request', daily));
  assert.equal(safe.code, 'model_daily_quota');
  assert.equal(safe.retryAfterMs, 3600000);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE|INPUT KEY|GenerateRequests/);
});

test('model cooldowns expire independently and concurrent failures cannot shorten the delay', () => {
  const gate = new ModelCooldowns();
  gate.defer('asr', { quotaKind: 'rate', retryAfterMs: 90000 }, 1000);
  gate.defer('asr', { quotaKind: 'unknown', retryAfterMs: 1000 }, 2000);
  assert.deepEqual(gate.remaining('asr', 3000), { quotaKind: 'rate', retryAfterMs: 88000 });
  assert.equal(gate.remaining('summary', 3000), undefined);
  assert.equal(gate.remaining('asr', 91000), undefined);
});

test('one 429 stops transport retries and suppresses later submissions until its deadline', async (t) => {
  let now = 1000,
    calls = 0,
    attempts = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1
      ? new Response(details(retry('90s')), { status: 429 })
      : new Response(JSON.stringify({ status: 'completed', steps: [] }));
  });
  const request = { model: 'rate-limit-fixture', input: 'fixture' };
  const submit = () => createInteraction(request, undefined, () => attempts++);
  await assert.rejects(
    submit(),
    (error) =>
      error instanceof GeminiError &&
      error.status === 429 &&
      error.rateLimit?.retryAfterMs === 90000,
  );
  now += 1000;
  await assert.rejects(
    submit(),
    (error) => {
      assert(error instanceof GeminiError);
      const failure = modelFailure(error);
      assert.equal(failure.code, 'processing_deferred');
      assert.equal(failure.source, 'cooldown');
      assert.equal(failure.providerStatus, undefined, 'no provider was contacted');
      assert.equal(failure.model, request.model);
      return error.rateLimit?.retryAfterMs === 89000;
    },
  );
  assert.equal(calls, 1);
  assert.equal(attempts, 1, 'suppressed requests must not count as submitted audio');
  await createInteraction({ ...request, model: 'unaffected-fixture' });
  assert.equal(calls, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createInteraction(request, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 2);
  now = 91000;
  await submit();
  assert.equal(calls, 3);
  assert.equal(attempts, 2);
});

test('cloud backoff grows only on new rejection rounds and resets after an hour without rejections', () => {
  const gate = new ModelCooldowns();
  const advice = { quotaKind: 'rate' as const, retryAfterMs: 60000 };
  let now = 1000;
  for (const delay of [60000, 120000, 240000, 480000, 900000, 900000]) {
    assert.equal(gate.reject('stt', advice, now).retryAfterMs, delay);
    assert.equal(gate.reject('stt', advice, now).retryAfterMs, delay, 'concurrent rejections share one round');
    assert.equal(gate.remaining('stt', now + 1000)?.retryAfterMs, delay - 1000);
    assert.equal(gate.remaining('stt', now + 2000)?.retryAfterMs, delay - 2000);
    now += delay;
  }
  assert.equal(gate.reject('stt', advice, now + 3600000).retryAfterMs, 60000);
  assert.equal(gate.reject('other-model', advice, now).retryAfterMs, 60000);
});

test('a provider-specified long wait remains authoritative over exponential backoff', () => {
  const gate = new ModelCooldowns();
  const advice = { quotaKind: 'daily' as const, retryAfterMs: 7200000 };
  assert.equal(gate.reject('stt', advice, 1000).retryAfterMs, 7200000);
  assert.equal(gate.reject('stt', { quotaKind: 'rate', retryAfterMs: 60000 }, 2000).retryAfterMs, 7199000);
  assert.equal(gate.remaining('stt', 2000)?.quotaKind, 'daily');
});
