import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseTranscript } from '../src/pipeline/source-materialize.js';
import { wavHeader, wavPayload } from '../src/http/routes/source.js';

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
