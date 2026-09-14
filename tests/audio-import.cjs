'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../audio-store.js');
require('../audio-import.js');
const meta = () => ({
  schema: 1,
  source: 'synap-native-ios',
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Native original',
  createdAt: '2026-09-01T10:00:00Z',
  deviceId: 'SYNAP-0123456789AB',
  completeFrames: 2,
  missingFrames: 1,
  pcmFrames: 1,
  adpcmFrames: 1,
  moments: [0.05, 0.15],
});
async function nativeWav(value = meta(), repeat = false) {
  const pcm = new Int16Array(2400);
  pcm[0] = -32768;
  pcm[2399] = 32767;
  const original = Buffer.from(await DKAudioCodec.wav([pcm]).arrayBuffer());
  const json = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(8);
  header.write('syap');
  header.writeUInt32LE(json.length, 4);
  const footer = Buffer.concat([header, json, Buffer.alloc(json.length % 2)]);
  const bytes = Buffer.concat([original, footer, ...(repeat ? [footer] : [])]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return new Blob([bytes], { type: 'audio/wav' });
}

test('native metadata and PCM are validated without changing the source WAV', async () => {
  const file = await nativeWav(),
    before = Buffer.from(await file.arrayBuffer());
  const data = await SynapAudioImport.inspect(file);
  assert.equal(data.audio.samples, 2400);
  assert.equal(data.native.missingFrames, 1);
  assert.deepEqual(data.native.moments, [0.05, 0.15]);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), before);
});

test('foreign ownership, session secrets and fields cannot become import metadata', async () => {
  const file = await nativeWav({
    ...meta(),
    ownerUid: 'someone-else',
    token: 'secret',
    deviceAssociationId: 'foreign',
  });
  const { native } = await SynapAudioImport.inspect(file);
  assert.equal(native.ownerUid, undefined);
  assert.equal(native.token, undefined);
  assert.equal(native.deviceAssociationId, undefined);
});

test('inconsistent frame counts, markers and duplicate native chunks are rejected', async () => {
  for (const edit of [
    { completeFrames: 3 },
    { pcmFrames: 2 },
    { moments: [0.151] },
    { moments: ['0.1'] },
    { id: '../../take' },
    { createdAt: 'bad' },
    { schema: 2 },
    { missingFrames: -1 },
  ]) {
    await assert.rejects(
      SynapAudioImport.inspect(await nativeWav({ ...meta(), ...edit })),
      /invalid synap metadata/,
    );
  }
  await assert.rejects(
    SynapAudioImport.inspect(await nativeWav(meta(), true)),
    /invalid synap metadata/,
  );
});

test('generic mono PCM WAVs import with exact sample counts; truncation and other formats fail', async () => {
  const file = DKAudioCodec.wav([new Int16Array([1, 2, 3])]);
  const result = await SynapAudioImport.inspect(file);
  assert.equal(result.native, null);
  assert.equal(result.audio.samples, 3);
  await assert.rejects(SynapAudioImport.inspect(file.slice(0, file.size - 1)), /incomplete WAV/);
  const bytes = Buffer.from(await file.arrayBuffer());
  bytes.writeUInt32LE(44100, 24);
  await assert.rejects(SynapAudioImport.inspect(new Blob([bytes])), /mono 16-bit PCM at 16 kHz/);
});

test('metadata inspection reads bounded headers even for a large source', async () => {
  const file = DKAudioCodec.wav([new Int16Array(16000 * 120)]);
  const slice = file.slice.bind(file);
  let biggest = 0;
  file.slice = (start, end) => {
    biggest = Math.max(biggest, end - start);
    return slice(start, end);
  };
  file.arrayBuffer = () => {
    throw Error('Whole-file read is forbidden');
  };
  assert.equal((await SynapAudioImport.inspect(file)).audio.samples, 16000 * 120);
  assert.ok(biggest <= 16);
});
