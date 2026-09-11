/**
 * Cloud Tasks must be able to reach the worker endpoint.
 *
 * Express runs a router's path-less middleware for every request entering that
 * router, before matching any route. Several routers call
 * router.use(requireAuth()), so if one of them is mounted ahead of taskRoutes,
 * a Cloud Tasks dispatch is checked as a user session token and rejected before
 * it reaches requireTaskAuth. Nothing fails loudly: the queue simply retries to
 * its backoff ceiling and gives up, and recordings sit at "uploaded" forever.
 *
 * This is asserted against a real HTTP request through the real app, because
 * the bug lives entirely in middleware ordering — no unit test of either
 * middleware in isolation can catch it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../src/http/app.js';

interface Result {
  status: number;
  code: string;
}

async function post(path: string, headers: Record<string, string>, body: string, method='POST'): Promise<Result> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body:method==='GET'?undefined:body,
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
  const result = await post('/v1/tasks/process', { Authorization: 'Bearer not-a-real-token' }, TASK_BODY);

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

test('the task router is mounted ahead of every blanket-auth router', async () => {
  // A structural guard to complement the behavioural one above. Both guards
  // answer a missing header with missing_token, so that case cannot tell them
  // apart; mounting order can be checked directly instead.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/http/app.ts', import.meta.url), 'utf8');

  const mounts = [...source.matchAll(/app\.use\('\/v1',\s*(\w+)\(\)\)/g)].map((m) => m[1]);
  const taskIndex = mounts.indexOf('taskRoutes');
  assert.notEqual(taskIndex, -1, 'taskRoutes is mounted');

  // authRoutes guards each route individually, so it is safe ahead of tasks.
  const blanketAuth = ['recordingRoutes', 'brainRoutes', 'memoryToolRoutes', 'voiceProfileRoutes'];
  for (const name of blanketAuth) {
    const index = mounts.indexOf(name);
    if (index === -1) continue;
    assert.ok(
      taskIndex < index,
      `${name} is mounted before taskRoutes; its router.use(requireAuth()) will swallow Cloud Tasks dispatches`,
    );
  }
});

test('user endpoints still require a user session', async () => {
  // Mounting task routes first must not have opened a hole in the authenticated
  // surface: /v1/recordings is still behind requireAuth.
  const result = await post('/v1/recordings', {}, JSON.stringify({}));
  assert.equal(result.status, 401);
  assert.equal(result.code, 'missing_token');
});

test('remembering, listing and forgetting voices all require a user session',async()=>{
  for(const [path,method] of [['/v1/known-speakers','GET'],['/v1/known-speakers/'+'a'.repeat(40),'DELETE'],['/v1/recordings/r/remember-speaker','POST']]){
    const result=await post(path!,{},JSON.stringify({consent:true}),method);
    assert.equal(result.status,401);assert.equal(result.code,'missing_token');
  }
});
