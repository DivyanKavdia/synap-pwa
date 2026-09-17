import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../src/config.js';
import { generateDek, openJson } from '../src/crypto/envelope.js';
import { keyring } from '../src/crypto/keyring.js';
import { createApp } from '../src/http/app.js';
import { issueTokens } from '../src/http/auth.js';
import { setFirestoreForTest } from '../src/store/firestore.js';
import { needsSpeakerAnnotations } from '../src/pipeline/rolling-transcription.js';
import { tagSelfSpeaker } from '../src/speaker/enrich.js';
import { makePcm16Wav } from '../src/speaker/audio.js';
import { applySelfOwnership } from '../src/gemini/memory.js';
import type { UserDoc, StructuredMemory, TranscriptWord } from '../src/store/types.js';

test('self voice setup preserves the confirmed name, controls annotation opt-in and isolates accounts', async t => {
  const docs = new Map<string, any>(), dek = generateDek();
  const snapshot = (path: string) => ({ exists: docs.has(path), data: () => docs.get(path) });
  const ref = (path: string): any => ({ path, collection: (id: string) => ref(path + '/' + id), doc: (id: string) => ref(path + '/' + id),
    get: async () => snapshot(path), set: async (value: any) => docs.set(path, value), delete: async () => docs.delete(path) });
  setFirestoreForTest({ collection: (name: string) => ref(name), runTransaction: async (fn: any) => fn({
    get: (r: any) => r.get(), update: (r: any, value: any) => docs.set(r.path, { ...docs.get(r.path), ...value }),
  }) } as any);
  t.mock.method(keyring, 'unwrap', async () => dek);
  const original = { ...config.speaker }, liveFetch = fetch;
  Object.assign(config.speaker, { serviceUrl: 'http://voice.test', authMode: 'none' });
  const embedding = Array.from({ length: 32 }, (_, i) => i === 0 ? 1 : 0);
  let submissions = 0;
  const server = http.createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  t.mock.method(globalThis, 'fetch', async (input: any, options?: RequestInit) => {
    if (String(input) === 'http://voice.test/embed') {
      submissions++;
      return Response.json({ embedding, model: 'fixture', duration_ms: 10000 });
    }
    assert(String(input).startsWith(origin));
    return liveFetch(input, options);
  });
  t.after(async () => { Object.assign(config.speaker, original); setFirestoreForTest(null); await new Promise<void>(resolve => server.close(() => resolve())); });
  const tokens: Record<string, string> = {};
  for (const uid of ['self', 'other']) {
    const user = { uid, tokenGeneration: 1 } as UserDoc;
    docs.set('users/' + uid, user);
    tokens[uid] = (await issueTokens(user)).access_token;
  }
  const request = async (method = 'GET', body?: any, name?: string, uid = 'self') => {
    const response = await fetch(origin + '/v1/voice-profile', { method,
      headers: { Authorization: 'Bearer ' + tokens[uid], 'Content-Type': method === 'POST' ? 'audio/wav' : 'application/json',
        ...(name !== undefined ? { 'X-Synap-Voice-Name': encodeURIComponent(name) } : {}) },
      body: method === 'POST' ? new Uint8Array(body) : body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() as any };
  };
  const audio = makePcm16Wav(Buffer.alloc(320000));
  assert.equal(await needsSpeakerAnnotations('self', dek), false);
  assert.equal((await request('POST', audio, 'Bad：Name')).status, 400);
  assert.equal(submissions, 0, 'invalid names are rejected before uploading audio to the speaker service');
  const enrolled = await request('POST', audio, 'Divyan Kavdia');
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.data.displayName, 'Divyan Kavdia');
  assert.equal(enrolled.data.supports_display_name, true);
  assert(!JSON.stringify(enrolled.data).includes('embedding'));
  assert(!JSON.stringify(docs.get('users/self/voiceProfiles/self')).includes('Divyan'));
  assert.equal(await needsSpeakerAnnotations('self', dek), true);
  assert.equal(await needsSpeakerAnnotations('other', dek), false);
  assert.equal((await request('GET', undefined, undefined, 'other')).data.enrolled, false);
  assert.equal((await request('PATCH', { display_name: 'Other' }, undefined, 'other')).status, 404);
  assert.equal((await request('PATCH', { display_name: 'Divyan K.' })).data.displayName, 'Divyan K.');
  const stored = openJson<any>(dek, docs.get('users/self/voiceProfiles/self').sealedProfile, { uid: 'self', scope: 'voiceProfile/self', field: 'profile' });
  assert.deepEqual(stored.embedding, embedding, 'a name correction does not replace the voice');
  assert.equal(submissions, 1, 'name-only updates do not submit audio');
  assert.equal((await request('POST', audio)).data.displayName, 'Divyan K.', 'older clients cannot erase a confirmed name on re-enrollment');
  const words: TranscriptWord[] = [
    { text: 'My words', speaker: 'S1', start_ms: 0, end_ms: 4000 },
    { text: 'Other words', speaker: 'S2', start_ms: 5000, end_ms: 9000 },
  ];
  let candidate = 0;
  const matched = await tagSelfSpeaker('self', dek, audio, words, 0, async () => ({
    embedding: candidate++ === 0 ? embedding : embedding.map((_, i) => i === 1 ? 1 : 0), model: 'fixture', duration_ms: 4000,
  }));
  assert.equal(matched.words[0]!.speaker, 'YOU');
  assert.equal(matched.words[1]!.speaker, 'S2');
  const uncertain = await tagSelfSpeaker('self', dek, audio, words, 0, async () => ({ embedding, model: 'fixture', duration_ms: 4000 }));
  assert.equal(uncertain.matchedSpeaker, null, 'ambiguous speakers remain unnamed');
  await request('DELETE', undefined, undefined, 'other');
  assert.equal((await request()).data.enrolled, true);
  await request('DELETE');
  assert.equal(await needsSpeakerAnnotations('self', dek), false);
});

test('only an exact verified owner name moves an action into My to-dos', () => {
  const memory = { people: [{ name: 'Divyan Kavdia', role: 'participant' }], conversations: [{ people: [],
    action_items: [{ task: 'Send plan', owner: 'Divyan Kavdia' }, { task: 'Confirm quote', owner: 'Divya Kavdia' }],
    follow_ups: [{ text: 'Check delivery', owner: 'Divyan Kavdia' }],
  }] } as unknown as StructuredMemory;
  assert.equal(applySelfOwnership(memory), memory, 'an unverified name is not identity evidence');
  const result = applySelfOwnership(memory, 'Divyan Kavdia');
  assert.equal(result.conversations[0]!.action_items[0]!.owner, 'self');
  assert.equal(result.conversations[0]!.action_items[1]!.owner, 'Divya Kavdia');
  assert.equal(result.conversations[0]!.follow_ups[0]!.owner, 'self');
});
