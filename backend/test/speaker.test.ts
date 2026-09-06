import assert from 'node:assert/strict';
import test from 'node:test';
import { cosineSimilarity, extractSpeakerSample, makePcm16Wav, parsePcm16Wav } from '../src/speaker/audio.js';
import type { TranscriptWord } from '../src/store/types.js';

function tone(seconds: number): Buffer {
  const samples = 16000 * seconds;
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin(index / 13) * 7000);
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}

test('speaker samples contain only diarized regions and stay valid 16 kHz WAV', () => {
  const wav = makePcm16Wav(tone(10));
  const words: TranscriptWord[] = [
    { text: 'hello', speaker: 'S1', start_ms: 1000, end_ms: 2600 },
    { text: 'there', speaker: 'S1', start_ms: 2700, end_ms: 4300 },
    { text: 'other', speaker: 'S2', start_ms: 5000, end_ms: 8000 },
  ];
  const sample = extractSpeakerSample(wav, words, 'S1', 0, 2500, 8000);
  assert.ok(sample);
  assert.ok(sample.speechMs >= 3000 && sample.speechMs < 4000);
  const parsed = parsePcm16Wav(sample.wav);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
});

test('short speakers are withheld instead of forcing an identity guess', () => {
  const wav = makePcm16Wav(tone(5));
  const words: TranscriptWord[] = [
    { text: 'hi', speaker: 'S1', start_ms: 500, end_ms: 1200 },
  ];
  assert.equal(extractSpeakerSample(wav, words, 'S1', 0, 2500, 8000), null);
});

test('cosine similarity is bounded and rejects incompatible vectors', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [1]), -1);
});
