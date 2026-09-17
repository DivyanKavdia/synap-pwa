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
    (error) => error instanceof GeminiError && error.rateLimit?.retryAfterMs === 89000,
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
