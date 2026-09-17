import test from 'node:test';
import assert from 'node:assert/strict';
import { associationBody } from '../src/http/routes/chakshu.js';
test('media association accepts only a real Chakshu target and identifier', () => {
  const device = { deviceId: 'SYNAP-112233445566', target: 'xiao-esp32s3-sense-8m' };
  assert.deepEqual(associationBody.parse(device), device);
  assert.throws(() => associationBody.parse({ ...device, target: 'esp32c3-supermini-4m' }));
  assert.throws(() => associationBody.parse({ ...device, deviceId: 'SYNAP-000000000000' }));
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Firestore } from '@google-cloud/firestore';
import { createApp } from '../src/http/app.js';
import { issueTokens } from '../src/http/auth.js';
import { generateDek } from '../src/crypto/envelope.js';
import { keyring } from '../src/crypto/keyring.js';
import { setFirestoreForTest } from '../src/store/firestore.js';
import { setSecretsForTest } from '../src/config.js';
import type { UserDoc } from '../src/store/types.js';

test('explicit JPEG vision is authenticated, bounded and leaves visual media local', async (t) => {
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
  setSecretsForTest({
    geminiApiKey: 'test-gemini-key',
    sessionSigningKey: Buffer.alloc(32, 7),
  });
  const originalFetch = fetch;
  let modelCalls = 0;
  let modelRequest: any = null;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('generativelanguage.googleapis.com')) {
      modelCalls++;
      modelRequest = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'A notebook on a desk.' }] }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
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
  const jsonRequest = async (path: string, method = 'GET', body?: object, owner = 'a') => {
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
  const device = { deviceId: 'SYNAP-112233445566', target: 'xiao-esp32s3-sense-8m' };
  try {
    assert.equal((await jsonRequest('/devices/chakshu', 'PUT', device)).status, 200);
    assert.equal((await jsonRequest('/devices')).data.devices.length, 1);
    assert.equal((await jsonRequest('/devices', 'GET', undefined, 'b')).data.devices.length, 0);
    const before = JSON.stringify([...docs]);

    // Normal/cloud media payloads remain invalid. Only one explicit JPEG body is accepted.
    const legacy = await jsonRequest('/chakshu/describe', 'POST', {
      deviceId: device.deviceId,
      prompt: 'Describe',
      frames: [{ jpeg: Buffer.from([255, 216, 1, 2, 255, 217]).toString('base64') }],
    });
    assert.equal(legacy.status, 400);
    assert.equal(legacy.data.error.code, 'invalid_image');
    assert.equal(modelCalls, 0);

    const malformed = await originalFetch(origin + '/v1/chakshu/describe', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokens.a, 'Content-Type': 'image/jpeg' },
      body: Buffer.from([255, 216, 1, 2]),
    });
    assert.equal(malformed.status, 400);
    assert.equal(modelCalls, 0);

    const image = Buffer.from([255, 216, 0, 1, 2, 3, 255, 217]);
    const described = await originalFetch(origin + '/v1/chakshu/describe', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokens.a, 'Content-Type': 'image/jpeg' },
      body: image,
    });
    assert.equal(described.status, 200);
    assert.deepEqual(await described.json(), { description: 'A notebook on a desk.' });
    assert.equal(modelCalls, 1);
    assert.equal(modelRequest.store, false);
    assert.equal(modelRequest.usage_label, undefined);
    assert.equal(modelRequest.input?.[1]?.type, 'image');
    assert.equal(modelRequest.input?.[1]?.mime_type, 'image/jpeg');
    assert.equal(modelRequest.input?.[1]?.data, image.toString('base64'));
    assert.match(modelRequest.system_instruction, /visibly supported/i);

    const unauthenticated = await originalFetch(origin + '/v1/chakshu/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: image,
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(modelCalls, 1);

    assert.equal(JSON.stringify([...docs]), before, 'vision does not upload or persist visual media');
    assert(
      !JSON.stringify(docs.get('users/a/devices/' + device.deviceId)).includes(device.deviceId),
      'association metadata is encrypted',
    );
  } finally {
    globalThis.fetch = originalFetch;
    setSecretsForTest(null);
    setFirestoreForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});