import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { Storage } from '@google-cloud/storage';
import { keyring } from '../src/crypto/keyring.js';
import { generateDek } from '../src/crypto/envelope.js';
import { setFirestoreForTest } from '../src/store/firestore.js';
import { runReadinessProbe } from '../src/ops/readiness.js';
import { verifySessionToken } from '../src/http/auth.js';

for (const mode of ['success', 'failure', 'voice', 'voice-failure']) test(`synthetic readiness ${mode} retains no user data or tokens`, async t => {
  const failure = mode === 'failure', voice = mode.startsWith('voice');
  const originalUrl = config.speaker.serviceUrl;
  Object.assign(config.speaker, { serviceUrl: voice ? 'http://speaker.test' : '' });
  t.after(() => Object.assign(config.speaker, { serviceUrl: originalUrl }));
  let enrolled = false;
  const rows = new Map<string, any>(), calls: string[] = [], deleted: string[] = [];
  let uid = '';
  const ref = (path: string): any => ({ path,
    collection: (part: string) => ref(`${path}/${part}`), doc: (part: string) => ref(`${path}/${part}`),
    set: async (value: any) => { rows.set(path, value); }, update: async () => {},
    where: () => ref(path), orderBy: () => ref(path), limit: () => ref(path), findNearest: () => ref(path),
    get: async () => ({ docs: [{ data: () => ({ conversationId: 'synthetic', personIds: [], embedding: [1] }) }] }),
  });
  setFirestoreForTest({ collection: (name: string) => ref(name), recursiveDelete: async (target: any) => { deleted.push(target.path); } } as any);
  t.after(() => setFirestoreForTest(null));
  t.mock.method(keyring, 'create', async (id: string) => {
    uid = id; return { dek: generateDek(), wrapped: { wrappedDek: 'test', keyVersion: 'test', createdAt: 'test' } };
  });
  t.mock.method(keyring, 'forget', () => {});
  t.mock.method(Storage.prototype, 'bucket', () => ({ deleteFiles: async (input: any) => { deleted.push(input.prefix); } }) as any);
  t.mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.includes('generativelanguage.googleapis.com')) {
      if (url.endsWith(':embedContent')) return Response.json({ embedding: { values: Array(768).fill(0.1) } });
      return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'OK' }] }] });
    }
    const token = (init?.headers as Record<string, string>).Authorization!.split(' ')[1]!;
    assert.equal((await verifySessionToken(token, 'access')).uid, uid);
    assert.match(uid, /^ops-probe-[a-f0-9-]{36}$/);
    if (url.includes('/segments/')) {
      assert.equal((init?.headers as any)['Content-Type'], 'audio/wav');
      assert.equal(Buffer.from(init!.body as Uint8Array).toString('ascii', 0, 4), 'RIFF');
      if (failure) return Response.json({ error: { code: 'model_rate_limited', providerStatus: 429,
        quotaKind: 'rate', message: 'PRIVATE PROVIDER DETAIL', token: 'PRIVATE TOKEN' } }, { status: 503 });
    }
    if (url.endsWith('/voice-profile')) {
      if (init?.method === 'POST') {
        assert.equal((init.headers as any)['Content-Type'], 'audio/wav');
        assert.equal(Buffer.from(init.body as Uint8Array).toString('ascii', 0, 4), 'RIFF');
        if (mode === 'voice-failure') return Response.json({ error: { code: 'speaker_service_failed' } }, { status: 503 });
        enrolled = true;
      }
      if (init?.method === 'DELETE') enrolled = false;
      return Response.json({ available: true, enrolled, displayName: 'Synthetic readiness check' });
    }
    if (url.endsWith('/processing')) return Response.json({ state: 'ready' });
    if (url.endsWith('/memory')) return Response.json({ transcript: 'Review the project report on Friday.', executive_summary: 'Report review.' });
    if (url.endsWith('/ask')) return Response.json({ answer: 'Review the project report.' });
    return Response.json({});
  });
  const result = await runReadinessProbe();
  assert.equal(result.ok, !failure && mode !== 'voice-failure');
  assert.equal(result.checks.some(check => check.name === 'voice_profile'), voice);
  assert.equal(enrolled, false);
  assert.deepEqual(deleted, [`audio/${uid}/`, `users/${uid}`]);
  assert.equal(rows.size, 1, 'only the generated synthetic account is provisioned directly');
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert(!JSON.stringify(result).includes(uid), 'report excludes account identifiers and session claims');
  assert.equal(calls.some(url => url.endsWith('/finalize')), !failure, 'failed transcription cannot be promoted as a completed queue run');
  assert.equal(calls.some(url => url.endsWith('/ask')), !failure);
});
