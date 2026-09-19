import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteraction, GeminiError, modelFailure } from '../src/gemini/client.js';
import { LONG_QUOTA_MS, ModelCooldowns, pacificDailyResetDelayMs, rateLimitAdvice, retrySpreadMs } from '../src/gemini/rate-limit.js';

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

test('daily quota classification waits until the documented Pacific reset', () => {
  const now = Date.parse('2026-09-17T00:00:00Z'); // 17:00 PDT on Sep 16.
  const daily = rateLimitAdvice(
    '120',
    details(quota('GenerateRequestsPerDayPerProjectPerModel'), quota('RequestsPerMinute')),
    now,
  );
  assert.deepEqual(daily, { quotaKind: 'daily', retryAfterMs: 7 * 60 * 60 * 1000 });
  assert.equal(rateLimitAdvice(null, details(quota('requests_per_minute')), now).quotaKind, 'rate');
  assert.equal(
    rateLimitAdvice(null, '{"error":{"message":"daily quota exceeded"}}', now).quotaKind,
    'unknown',
  );
  const safe = modelFailure(new GeminiError('PRIVATE INPUT KEY', 429, true, 'request', daily));
  assert.equal(safe.code, 'model_daily_quota');
  assert.equal(safe.retryAfterMs, 7 * 60 * 60 * 1000);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE|INPUT KEY|GenerateRequests/);
});

test('Pacific daily reset calculation follows daylight-saving time', () => {
  assert.equal(
    pacificDailyResetDelayMs(Date.parse('2026-01-18T10:00:00Z')),
    22 * 60 * 60 * 1000,
    '02:00 PST waits until 08:00Z midnight',
  );
  assert.equal(
    pacificDailyResetDelayMs(Date.parse('2026-09-18T10:00:00Z')),
    21 * 60 * 60 * 1000,
    '03:00 PDT waits until 07:00Z midnight',
  );
  assert.equal(
    pacificDailyResetDelayMs(Date.parse('2026-03-08T07:30:00Z')),
    30 * 60 * 1000,
    '23:30 PST before the spring transition still resets at local midnight',
  );
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

test('a long unknown wait is relabelled daily without changing its timing', () => {
  const now = Date.parse('2026-09-19T00:00:00.000Z');
  // The exact RetryInfo Gemini returned on 19 Sep: 49605s + 573ms, arriving
  // with no QuotaFailure violation, so the classifier saw only "unknown".
  const body = JSON.stringify({
    error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo',
      retryDelay: { seconds: '49605', nanos: 573000000 } }] },
  });
  const advice = rateLimitAdvice(null, body, now);
  assert.equal(advice.retryAfterMs, 49605573, 'timing is still the provider value');
  assert.equal(advice.quotaKind, 'daily', 'a 13-hour wait is not a per-minute limit');

  // Short waits keep their honest "unknown" label and their own timing.
  assert.deepEqual(rateLimitAdvice('120', 'not JSON', now), {
    quotaKind: 'unknown', retryAfterMs: 120000,
  });
});

test('long shared waits are spread per recording, short ones are not', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(retrySpreadMs('rec-a', 60000), 0, 'a one-minute wait is left alone');
  assert.equal(retrySpreadMs('rec-a', LONG_QUOTA_MS - 1), 0);

  const a = retrySpreadMs('rec-a', day);
  const b = retrySpreadMs('rec-b', day);
  for (const value of [a, b]) {
    assert.ok(Number.isInteger(value) && value >= 0 && value < 15 * 60 * 1000);
  }
  assert.notEqual(a, b, 'two recordings must not wake in the same instant');
  assert.equal(retrySpreadMs('rec-a', day), a, 'stable, so the Cloud Tasks dedup name is stable');

  // The whole point: deadlines land across a window instead of on one second.
  const spread = new Set(Array.from({ length: 200 }, (_, i) => retrySpreadMs('rec-' + i, day)));
  assert.ok(spread.size > 150, 'spread should be well distributed, saw ' + spread.size);
});
