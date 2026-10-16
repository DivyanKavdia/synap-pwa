'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../audio-store.js');
const codec = globalThis.DKAudioCodec;

test('Odyssey C3 4 KiB SD WAV is restored byte-for-byte after 1600-byte journal padding', async () => {
  const sourcePcmBytes = 888832 - 44; // Oct 8 build 1859 observed SD download.
  const pcm = new Uint8Array(sourcePcmBytes);
  for (let i = 0; i < pcm.length; ++i) pcm[i] = i % 251;
  const padded = new Uint8Array(Math.ceil(pcm.length / codec.PCM_BYTES_PER_FRAME) * codec.PCM_BYTES_PER_FRAME);
  padded.set(pcm);
  assert.equal(padded.length - pcm.length, 812);
  const raw = codec.wav([pcm]);
  const imported = codec.wav(codec.trimImportedPcm([padded], sourcePcmBytes));
  assert.equal(imported.size, 888832);
  assert.deepEqual(Buffer.from(await imported.arrayBuffer()), Buffer.from(await raw.arrayBuffer()));
  // The journal's storage format stays frame-aligned; only exported WAV is trimmed.
  assert.equal(padded.length % codec.PCM_BYTES_PER_FRAME, 0);
});

test('imported frame trimming rejects inconsistent lengths and tampered padding', () => {
  const stored = new Uint8Array(3200);
  assert.equal(codec.trimImportedPcm([stored], 3200)[0].byteLength, 3200);
  assert.throws(() => codec.trimImportedPcm([stored], 1600), /imported PCM length mismatch/);
  assert.throws(() => codec.trimImportedPcm([stored], 3201), /imported PCM length mismatch/);
  assert.throws(() => codec.trimImportedPcm([stored], 3199), /imported PCM length mismatch/);
  stored[3199] = 1;
  assert.throws(() => codec.trimImportedPcm([stored], 2400), /padding was modified/);
});

test('SD import records exact source length; normal BLE recording remains untrimmed', () => {
  const root = path.join(__dirname, '..');
  const media = fs.readFileSync(path.join(root, 'devices/chakshu/media.js'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'audio-store.js'), 'utf8');
  assert.match(media, /sourcePcmBytes: bytes\.length - 44/);
  assert.match(store, /trimImportedPcm\(pcm, record\.sourcePcmBytes\)/);
  assert.match(store, /Number\.isSafeInteger\(record\.sourcePcmBytes\)/);
  assert.match(store, /sizeBytes: timelineFrames \? 44 \+ \(exactBytes \?\? storedBytes\) : 0/);
});
