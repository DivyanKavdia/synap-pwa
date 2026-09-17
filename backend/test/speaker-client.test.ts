import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleAuth } from 'google-auth-library';
import { config } from '../src/config.js';
import { embedSpeakerAudio } from '../src/speaker/client.js';

test('speaker deadline bounds token lookup, HTTP and response parsing without late uploads or retries', async t => {
  const original = { ...config.speaker };
  Object.assign(config.speaker, { serviceUrl: 'http://speaker.test', authMode: 'oidc', requestTimeoutMs: 20 });
  t.after(() => Object.assign(config.speaker, original));
  let releaseToken!: (client: any) => void;
  let uploads = 0;
  t.mock.method(GoogleAuth.prototype, 'getIdTokenClient', () => new Promise(resolve => { releaseToken = resolve; }));
  const audio = Buffer.alloc(44);
  const timeout = (error: any) => error.code === 'speaker_service_timeout';
  await assert.rejects(embedSpeakerAudio(audio), timeout);
  releaseToken({ request: async () => { uploads++; return {}; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploads, 0, 'expired token lookup cannot upload later');
  let requestSignal: AbortSignal | undefined;
  t.mock.method(GoogleAuth.prototype, 'getIdTokenClient', async () => ({ request: async (options: any) => {
    uploads++; requestSignal = options.signal;
    assert.equal(options.retry, false);
    return new Promise(() => {});
  } }));
  await assert.rejects(embedSpeakerAudio(audio), timeout);
  assert.equal(uploads, 1);
  assert.equal(requestSignal?.aborted, true);
  const result = { embedding: Array(32).fill(0.1), model: 'fixture', duration_ms: 6885 };
  t.mock.method(GoogleAuth.prototype, 'getIdTokenClient', async () => ({ request: async () => ({ data: result }) }));
  assert.deepEqual(await embedSpeakerAudio(audio), result, 'a timeout does not poison subsequent credential discovery');
  Object.assign(config.speaker, { authMode: 'none' });
  t.mock.method(globalThis, 'fetch', async (_url: any, options: any) => {
    requestSignal = options.signal;
    return { ok: true, json: () => new Promise(() => {}) } as Response;
  });
  await assert.rejects(embedSpeakerAudio(audio), timeout);
  assert.equal(requestSignal?.aborted, true, 'a stalled response body is bounded too');
});
