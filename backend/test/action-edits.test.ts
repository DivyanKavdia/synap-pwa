import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateDek, openJson, sealJson } from '../src/crypto/envelope.js';
import { keyring } from '../src/crypto/keyring.js';
import { createApp } from '../src/http/app.js';
import { issueTokens } from '../src/http/auth.js';
import { setFirestoreForTest } from '../src/store/firestore.js';
import type { UserDoc } from '../src/store/types.js';

test('action edits validate dates, fence revisions, preserve source and invalidate the daily brief in the owning account', async (t) => {
  const dek = generateDek(),
    docs = new Map<string, any>(),
    bound = { uid: 'u', scope: 'followUp/a', field: 'task' };
  const ref = (path: string): any => ({
    path,
    collection: (name: string) => ref(path + '/' + name),
    doc: (id: string) => ref(path + '/' + id),
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  });
  setFirestoreForTest({
    collection: (name: string) => ref(name),
    runTransaction: async (fn: any) => {
      const writes: (() => void)[] = [];
      const result = await fn({
        get: (r: any) => {
          assert.equal(writes.length, 0, 'transaction reads precede writes');
          return r.get();
        },
        update: (r: any, value: any) =>
          writes.push(() => docs.set(r.path, { ...docs.get(r.path), ...value })),
        delete: (r: any) => writes.push(() => docs.delete(r.path)),
      });
      writes.forEach((write) => write());
      return result;
    },
  } as any);
  t.mock.method(keyring, 'unwrap', async () => dek);
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    setFirestoreForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    tokens: Record<string, string> = {};
  for (const uid of ['u', 'other']) {
    const user = { uid, tokenGeneration: 1 } as UserDoc;
    docs.set('users/' + uid, user);
    tokens[uid] = (await issueTokens(user)).access_token;
  }
  const original = {
    task: 'Send plan',
    owner: 'Riya',
    evidence: 'I will send the plan tomorrow',
    context: 'Launch',
  };
  docs.set('users/u/followUps/a', {
    followUpId: 'a',
    recordingId: 'r',
    state: 'done',
    updatedAt: 'v1',
    dueDate: '2026-09-18',
    sealedTask: sealJson(dek, original, bound),
  });
  docs.set('users/u/recordings/r', { day: '2026-09-17' });
  docs.set('users/u/days/2026-09-17', { old: true });
  const patch = async (body: any, uid = 'u', id = 'a') => {
    const response = await fetch(origin + '/v1/follow-ups/' + id, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + tokens[uid], 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  for (const due_date of ['2026-02-30', 'next week', '2026-13-01'])
    assert.equal((await patch({ due_date })).status, 400);
  assert.equal((await patch({ due_date: '2026-09-20' }, 'other')).status, 404);
  assert.equal((await patch({ state: 'open' }, 'u', 'missing')).status, 404);
  assert.equal((await patch({ due_date: '2026-09-20', revision: 'stale' })).status, 409);
  assert(docs.has('users/u/days/2026-09-17'), 'rejected edits leave the brief intact');
  const saved = await patch({
    revision: 'v1',
    task: 'Email final plan',
    owner: 'self',
    due_date: '2026-09-21',
    check_in_date: '2026-09-19',
    pinned: true,
  });
  assert.equal(saved.status, 200);
  assert(saved.data.revision && saved.data.revision !== 'v1');
  const row = docs.get('users/u/followUps/a'),
    content = openJson<any>(dek, row.sealedTask, bound);
  assert.equal(row.state, 'done', 'editing must not reopen completed work');
  assert.equal(row.dueDateSource, 'user');
  assert.equal(row.checkInDate, '2026-09-19');
  assert.equal(content.sourceTask, 'Send plan');
  assert.equal(content.evidence, original.evidence);
  assert.equal(content.task, 'Email final plan');
  assert.equal(row.ownerType, 'self');
  assert(!docs.has('users/u/days/2026-09-17'));
  assert.throws(() => openJson(dek, row.sealedTask, { ...bound, uid: 'other' }));
  assert.equal(
    (await patch({ revision: 'v1', state: 'open' })).status,
    409,
    'an old screen cannot overwrite the new edit',
  );
});
