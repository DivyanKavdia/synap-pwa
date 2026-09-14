import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseTranscript } from '../src/pipeline/source-materialize.js';
import { byteOffset, wavHeader, wavPayload } from '../src/http/routes/source.js';
import { makePcm16Wav, parsePcm16Wav } from '../src/speaker/audio.js';

test('segment windows replace a non-empty but truncated recording transcript', () => {
  const stored = '[00:00] S1: first half only';
  const windows = [
    '[00:00] S?: first half only',
    '[00:30] S?: second half that was previously hidden',
  ];
  const selected = chooseTranscript(stored, windows);
  assert.equal(selected.source, 'segments');
  assert.match(selected.text, /first half only/);
  assert.match(selected.text, /second half that was previously hidden/);
});

test('a complete diarized recording transcript remains preferred', () => {
  const stored = '[00:00] S1: hello there\n[00:30] S2: final decision';
  const windows = ['[00:00] S?: hello there', '[00:30] S?: final decision'];
  const selected = chooseTranscript(stored, windows);
  assert.equal(selected.source, 'recording');
  assert.equal(selected.text, stored);
});

test('WAV source reconstruction emits a valid PCM header and extracts its payload', () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
  const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wavPayload(wav), pcm);
});

test('WAV payload parsing does not assume a fixed 44-byte header', () => {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const junk = Buffer.alloc(12);
  junk.write('JUNK', 0, 'ascii');
  junk.writeUInt32LE(4, 4);
  junk.writeUInt32LE(0x12345678, 8);
  const pcm = Buffer.from([7, 8, 9, 10]);
  const data = Buffer.alloc(8);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(pcm.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(fmt.length + junk.length + data.length + pcm.length + 4, 4);
  riff.write('WAVE', 8, 'ascii');
  const wav = Buffer.concat([riff, fmt, junk, data, pcm]);
  assert.deepEqual(wavPayload(wav), pcm);
});

test('fractional source timing never inserts a half sample before the recording', () => {
  // The old byte rounding inserts one byte at 0.02 ms, shifting every sample.
  assert.equal(byteOffset(0.02), 0);
  assert.equal(byteOffset(0.04), 2);
  for (const ms of [0, 0.02, 0.04, 1.01, 29999.99, 30000, 19200.02]) {
    assert.equal(byteOffset(ms) % 2, 0);
    assert(Math.abs(byteOffset(ms) / 32 - ms) <= (1 / 32000) * 1000);
  }
  const pcm = Buffer.from([37, 0, 34, 0, 37, 0, 34, 0]);
  const rebuilt = Buffer.concat([wavHeader(pcm.length), Buffer.alloc(byteOffset(0.02)), pcm]);
  assert.deepEqual(wavPayload(rebuilt), pcm);
});

test('WAV writers and readers reject the extra-byte corruption without dropping evidence', () => {
  for (const count of [1, 1601, -2, 1.5, NaN, 0xffffffff]) assert.throws(() => wavHeader(count));
  assert.throws(() => makePcm16Wav(Buffer.alloc(1601)), /incomplete PCM/);
  const pcm = Buffer.alloc(614400, 37);
  const broken = Buffer.concat([wavHeader(pcm.length), Buffer.alloc(1), pcm]);
  broken.writeUInt32LE(broken.length - 8, 4);
  broken.writeUInt32LE(pcm.length + 1, 40);
  const before = Buffer.from(broken);
  assert.throws(() => wavPayload(broken), /incomplete PCM sample/);
  assert.throws(() => parsePcm16Wav(broken), /incomplete PCM sample/);
  assert.deepEqual(broken, before);
});

test('WAV validation rejects truncated containers, inconsistent format and partial data chunks', () => {
  const valid = makePcm16Wav(Buffer.alloc(1600));
  for (const change of [
    (b: Buffer) => b.writeUInt32LE(b.length, 4),
    (b: Buffer) => b.writeUInt32LE(1602, 40),
    (b: Buffer) => b.writeUInt32LE(1598, 40),
    (b: Buffer) => b.writeUInt16LE(3, 20),
    (b: Buffer) => b.writeUInt16LE(2, 22),
    (b: Buffer) => b.writeUInt32LE(48000, 24),
    (b: Buffer) => b.writeUInt32LE(32001, 28),
    (b: Buffer) => b.writeUInt16LE(1, 32),
    (b: Buffer) => b.writeUInt16LE(8, 34),
  ]) {
    const broken = Buffer.from(valid);
    change(broken);
    assert.throws(() => wavPayload(broken));
  }
  const junk = Buffer.alloc(12);
  junk.write('JUNK');
  junk.writeUInt32LE(3, 4);
  const padded = Buffer.concat([valid.subarray(0, 36), junk, valid.subarray(36)]);
  padded.writeUInt32LE(padded.length - 8, 4);
  assert.deepEqual(wavPayload(padded), valid.subarray(44));
});
