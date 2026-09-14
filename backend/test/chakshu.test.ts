import test from 'node:test';
import assert from 'node:assert/strict';
import { associationBody, describeBody, imageParts } from '../src/http/routes/chakshu.js';
test('media boundary accepts only the Chakshu account association and bounded JPEG windows', () => {
  const device = { deviceId: 'SYNAP-112233445566', target: 'xiao-esp32s3-sense-8m' };
  assert.deepEqual(associationBody.parse(device), device);
  assert.throws(() => associationBody.parse({ ...device, target: 'esp32c3-supermini-4m' }));
  assert.throws(() => associationBody.parse({ ...device, deviceId: 'SYNAP-000000000000' }));
  const input = {
    deviceId: device.deviceId,
    prompt: 'Explain',
    frames: [{ atMs: 100, jpeg: Buffer.from([255, 216, 1, 2, 255, 217]).toString('base64') }],
  };
  const parts = imageParts(describeBody.parse(input));
  assert.equal(parts.filter((p) => p.type === 'image').length, 1);
  assert(!parts.some((p) => p.type === 'audio'));
  assert.throws(() => describeBody.parse({ ...input, frames: Array(6).fill(input.frames[0]) }));
  assert.throws(() => describeBody.parse({ ...input, video: 'base64 video' }));
  assert.throws(() =>
    imageParts({ ...input, frames: [...input.frames, { ...input.frames[0]!, atMs: 1 }] }),
  );
  assert.throws(() =>
    imageParts({
      ...input,
      frames: [{ atMs: 0, jpeg: Buffer.from('not jpeg').toString('base64') }],
    }),
  );
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Firestore } from '@google-cloud/firestore';
import { createApp } from '../src/http/app.js';
import { issueTokens } from '../src/http/auth.js';
import { generateDek } from '../src/crypto/envelope.js';
import { keyring } from '../src/crypto/keyring.js';
import { setFirestoreForTest } from '../src/store/firestore.js';
import type { UserDoc } from '../src/store/types.js';
test('real media routes enforce account isolation and never send video/audio to vision', async (t) => {
  const docs = new Map<string, any>(),
    dek = generateDek();
  const snapshot = (path: string) => ({
    id: path.split('/').at(-1),
    exists: docs.has(path),
    data: () => docs.get(path),
  });
  const ref = (path: string): any => ({
    path,
    collection: (id: string) => ref(path + '/' + id),
    doc: (id: string) => ref(path + '/' + id),
    get: async () => snapshot(path),
    set: async (value: any) => docs.set(path, value),
    limit: () => ({
      get: async () => ({
        docs: [...docs.keys()]
          .filter((key) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/'))
          .map(snapshot),
      }),
    }),
  });
  setFirestoreForTest({
    collection: (name: string) => ref(name),
    runTransaction: async (fn: any) =>
      fn({
        get: async (r: any) => snapshot(r.path),
        set: (r: any, v: any) => docs.set(r.path, v),
        update: (r: any, v: any) => docs.set(r.path, { ...docs.get(r.path), ...v }),
      }),
  } as unknown as Firestore);
  t.mock.method(keyring, 'unwrap', async () => dek);
  const originalFetch = fetch;
  let modelCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(String(init?.body));
      modelCalls++;
      assert.equal(body.store, false);
      assert.equal(body.input.filter((p: any) => p.type === 'image').length, 1);
      assert(!body.input.some((p: any) => p.type === 'audio' || p.type === 'video'));
      return new Response(
        JSON.stringify({
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'A table.' }] }],
        }),
      );
    }
    return originalFetch(input, init);
  };
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    tokens: Record<string, string> = {};
  for (const uid of ['a', 'b']) {
    const user = { uid, tokenGeneration: 1 } as UserDoc;
    docs.set('users/' + uid, user);
    tokens[uid] = (await issueTokens(user)).access_token;
  }
  const request = async (path: string, method = 'GET', body?: object, owner = 'a') => {
    const response = await fetch(origin + '/v1' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + (tokens[owner] || 'invalid'),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  const device = { deviceId: 'SYNAP-112233445566', target: 'xiao-esp32s3-sense-8m' },
    input = {
      deviceId: device.deviceId,
      prompt: 'Describe',
      frames: [{ atMs: 0, jpeg: Buffer.from([255, 216, 1, 2, 255, 217]).toString('base64') }],
    };
  try {
    assert.equal((await request('/chakshu/describe', 'POST', input)).status, 403);
    assert.equal(modelCalls, 0);
    assert.equal((await request('/devices/chakshu', 'PUT', device)).status, 200);
    assert.equal((await request('/devices')).data.devices.length, 1);
    assert.equal((await request('/devices', 'GET', undefined, 'b')).data.devices.length, 0);
    assert.equal((await request('/chakshu/describe', 'POST', input, 'b')).status, 403);
    const result = await request('/chakshu/describe', 'POST', input);
    assert.equal(result.status, 200);
    assert.equal(result.data.description, 'A table.');
    assert.equal(modelCalls, 1);
    assert.equal(
      (
        await request('/chakshu/describe', 'POST', {
          ...input,
          frames: Array(6).fill(input.frames[0]),
        })
      ).status,
      400,
    );
    assert.equal(modelCalls, 1);
    assert.equal((await request('/devices', 'GET', undefined, 'no-account')).status, 401);
    assert(
      !JSON.stringify(docs.get('users/a/devices/' + device.deviceId)).includes(device.deviceId),
      'association metadata is encrypted',
    );
  } finally {
    globalThis.fetch = originalFetch;
    setFirestoreForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
