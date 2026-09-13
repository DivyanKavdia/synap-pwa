/** Exercise authentication through the real HTTP app, including the separate task guard. */

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../src/http/app.js';

interface Result {
  status: number;
  code: string;
}

async function post(
  path: string,
  headers: Record<string, string>,
  body: string,
  method = 'POST',
): Promise<Result> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : body,
    });
    const text = await response.text();
    let code = '';
    try {
      code = String((JSON.parse(text) as { error?: { code?: string } })?.error?.code ?? '');
    } catch {
      code = '';
    }
    return { status: response.status, code };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const TASK_BODY = JSON.stringify({ uid: 'u', recordingId: 'r' });

test('a task dispatch reaches the task guard, not the user session guard', async () => {
  // A deliberately invalid token. What matters is *which* guard rejects it:
  // invalid_task_token means the request reached taskRoutes. Any user-session
  // error means a router with blanket requireAuth swallowed it first, which is
  // the outage this test exists to prevent.
  const result = await post(
    '/v1/tasks/process',
    { Authorization: 'Bearer not-a-real-token' },
    TASK_BODY,
  );

  assert.notEqual(
    result.code,
    'missing_token',
    'the user session guard answered a Cloud Tasks path',
  );
  assert.notEqual(
    result.code,
    'unknown_user',
    'the user session guard answered a Cloud Tasks path',
  );
  assert.equal(
    result.code,
    'invalid_task_token',
    `expected requireTaskAuth to reject this, got ${result.status} ${result.code}`,
  );
});

test('unmatched paths do not enter an unrelated user-auth router', async () => {
  const result = await post('/v1/no-such-resource', {}, '', 'GET');
  assert.equal(result.status, 404);
  assert.equal(result.code, 'not_found');
});

const protectedRoutes = [
  ['GET', '/v1/days/2026-09-12/brief'],
  ['POST', '/v1/days/2026-09-12/brief/rebuild'],
  ['GET', '/v1/people'],
  ['GET', '/v1/people/person/preparation'],
  ['PATCH', '/v1/people/person'],
  ['DELETE', '/v1/people/person'],
  ['GET', '/v1/follow-ups'],
  ['PATCH', '/v1/follow-ups/item'],
  ['GET', '/v1/memory-merges'],
  ['POST', '/v1/memory-merges'],
  ['DELETE', '/v1/memory-merges/merge'],
  ['GET', '/v1/voice-profile'],
  ['POST', '/v1/voice-profile'],
  ['DELETE', '/v1/voice-profile'],
  ['POST', '/v1/recordings'],
  ['PUT', '/v1/recordings/recording/segments/0'],
  ['POST', '/v1/recordings/recording/highlights'],
  ['POST', '/v1/recordings/recording/finalize'],
  ['GET', '/v1/recordings/recording/processing'],
  ['GET', '/v1/recordings'],
  ['GET', '/v1/recordings/recording/memory'],
  ['DELETE', '/v1/recordings/recording'],
  ['POST', '/v1/ask'],
] as const;

for (const [method, path] of protectedRoutes) {
  test(`${method} ${path} requires a user session before handling input`, async () => {
    const result = await post(path, {}, '{}', method);
    assert.equal(result.status, 401);
    assert.equal(result.code, 'missing_token');
  });
}

test('user endpoints still require a user session', async () => {
  // Mounting task routes first must not have opened a hole in the authenticated
  // surface: /v1/recordings is still behind requireAuth.
  const result = await post('/v1/recordings', {}, JSON.stringify({}));
  assert.equal(result.status, 401);
  assert.equal(result.code, 'missing_token');
});

test('remembering, listing and forgetting voices all require a user session', async () => {
  for (const [path, method] of [
    ['/v1/known-speakers', 'GET'],
    ['/v1/known-speakers/' + 'a'.repeat(40), 'DELETE'],
    ['/v1/recordings/r/remember-speaker', 'POST'],
  ]) {
    const result = await post(path!, {}, JSON.stringify({ consent: true }), method);
    assert.equal(result.status, 401);
    assert.equal(result.code, 'missing_token');
  }
});
