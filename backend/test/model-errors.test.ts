import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { GeminiError, modelFailure } from '../src/gemini/client.js';
import { errorHandler } from '../src/http/errors.js';
import { processingFailure } from '../src/pipeline/process.js';

test('public model diagnostics classify failures without returning provider bodies', () => {
  for (const [status, reason, code, retryable] of [
    [0, 'missing-text', 'model_missing_text', true],
    [0, 'incomplete', 'model_incomplete', true],
    [400, 'request', 'model_request_rejected', false],
    [401, 'request', 'model_access_denied', false],
    [403, 'request', 'model_access_denied', false],
    [404, 'request', 'model_not_found', false],
    [429, 'request', 'model_rate_limited', true],
    [503, 'request', 'model_unavailable', true],
  ] as const) {
    const error = new GeminiError('PRIVATE AUDIO TRANSCRIPT API KEY', status, retryable, reason);
    const safe = modelFailure(error);
    assert.equal(safe.code, code);
    assert.equal(safe.providerStatus, status);
    assert.equal(safe.retryable, retryable);
    assert.doesNotMatch(JSON.stringify(safe), /PRIVATE|API KEY/);
    assert.equal(processingFailure(error).message, safe.message);
    const headers: Record<string, string> = {};
    let responseStatus = 0,
      body: any;
    const res = {
      headersSent: false,
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      status(value: number) {
        responseStatus = value;
        return this;
      },
      json(value: unknown) {
        body = value;
      },
    };
    errorHandler()(
      error,
      { path: '/v1/recordings/r/segments/1' } as Request,
      res as unknown as Response,
      (() => {}) as NextFunction,
    );
    assert.equal(responseStatus, retryable ? 503 : 502);
    assert.deepEqual(body.error, safe);
    assert.equal(
      headers['Retry-After'],
      reason === 'missing-text' ? '120' : status === 429 ? '60' : undefined,
    );
    if (reason === 'missing-text') assert.equal(safe.retryAfterMs, 120000);
  }
});

test('missing transcription output retains its model route and a durable retry delay', () => {
  const route = { model: 'gemini-3.5-transcribe', stage: 'transcription' };
  const failure = modelFailure(new GeminiError('PRIVATE AUDIO', 0, true, 'missing-text', undefined, route));
  assert.equal(failure.code, 'model_missing_text');
  assert.equal(failure.model, route.model);
  assert.equal(failure.modelStage, route.stage);
  assert.equal(failure.retryAfterMs, 120000);
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE AUDIO/);
});

test('diagnostics distinguish a provider rejection from a suppressed request without exposing its body', () => {
  const advice = { quotaKind: 'unknown' as const, retryAfterMs: 120000 };
  const route = { model: 'gemini-3.5-transcribe', stage: 'transcription' };
  const rejected = modelFailure(new GeminiError('PRIVATE KEY AUDIO', 429, true, 'request', advice, route));
  const deferred = modelFailure(new GeminiError('PRIVATE KEY AUDIO', 429, true, 'cooldown', advice, route));
  assert.equal(rejected.source, 'provider');
  assert.equal(rejected.providerStatus, 429);
  assert.equal(deferred.source, 'cooldown');
  assert.equal(deferred.providerStatus, undefined);
  assert.equal(deferred.code, 'processing_deferred');
  for (const failure of [rejected, deferred]) {
    assert.equal(failure.model, route.model);
    assert.equal(failure.modelStage, route.stage);
    assert.equal(failure.retryAfterMs, 120000);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE|KEY AUDIO/);
  }
});
