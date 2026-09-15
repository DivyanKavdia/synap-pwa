'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../audio-store.js');
const codec = require('../audio-codec-v3.js');
const { repair } = require('../tools/repair-pcm-alignment.cjs');

function malformed(wav, edit) {
  const bytes = Buffer.from(wav);
  edit(bytes);
  return new Blob([bytes], { type: 'audio/wav' });
}

test('compressed speech retains every PCM byte through the 19.2-second WAV export', async () => {
  const frames = [];
  for (let frame = 0; frame < 384; frame++) {
    const samples = new Int16Array(800);
    for (let i = 0; i < 800; i++) samples[i] = Math.round(1000 * Math.sin((frame * 800 + i) / 11));
    frames.push(codec.decodeFrame(codec.encodeFrame(samples)));
  }
  const source = Buffer.concat(frames);
  const blob = DKAudioCodec.wav(frames);
  const wav = Buffer.from(await blob.arrayBuffer());
  assert.deepEqual(wav.subarray(44), source);
  assert.deepEqual(await DKAudioCodec.validateWav(blob), {
    start: 44,
    bytes: 614400,
    samples: 307200,
  });
  assert.equal(wav.length, 614444);
  // Same corruption shape as the supplied recording, generated without user audio.
  const broken = Buffer.concat([wav.subarray(0, 44), Buffer.alloc(1), source]);
  broken.writeUInt32LE(broken.length - 8, 4);
  broken.writeUInt32LE(source.length + 1, 40);
  const before = Buffer.from(broken);
  assert.deepEqual(repair(broken), wav, 'explicit recovery restores the exact original bytes');
  assert.deepEqual(broken, before, 'recovery never rewrites the supplied source');
  assert.throws(() => repair(wav), /does not match/, 'valid recordings must not be shifted');
  const uncertain = Buffer.from(broken);
  uncertain.writeInt16LE(30000, 47);
  assert.throws(() => repair(uncertain), /do not exactly match/, 'uncertain audio is never repaired by guessing');
  await assert.rejects(DKAudioCodec.validateWav(new Blob([broken])), {
    code: 'audio_integrity',
    retryable: false,
  });
});

test('WAV writing rejects individual split samples even when total bytes are even', async () => {
  for (const frames of [
    [new Uint8Array(1)],
    [new Uint8Array(1), new Uint8Array(1599)],
    [{ byteLength: 1600 }],
  ]) {
    assert.throws(() => DKAudioCodec.wav(frames), /incomplete PCM/);
  }
  const backing = new Uint8Array([99, 99, 1, 2, 3, 4, 99, 99]);
  const bytes = Buffer.from(
    await DKAudioCodec.wav([new DataView(backing.buffer, 2, 4)]).arrayBuffer(),
  );
  assert.deepEqual([...bytes.subarray(44)], [1, 2, 3, 4], 'only the supplied view is exported');
});

test('corrupt compaction cannot delete packets, and corrupt stored PCM cannot be exported', async () => {
  const store = new DKAudioStore();
  store.atomic = async () => {
    throw Error('Must not enter the write transaction');
  };
  await assert.rejects(
    store.compactSegment('take', 0, {
      frames: [new Uint8Array(1601)],
      completeFrames: 1,
      missing: 0,
      incomplete: 0,
    }),
    { code: 'audio_integrity' },
  );
  const segment = { index: 0, pcmBlob: new Blob([new Uint8Array(1601)]) };
  store.get = async () => segment;
  store.all = async () => [segment];
  await assert.rejects(store.segment('take', 0), { code: 'audio_integrity' });
  await assert.rejects(store.blob({ id: 'take' }), { code: 'audio_integrity' });
  assert.equal(segment.pcmBlob.size, 1601, 'raw stored evidence is not trimmed or rewritten');
});

test('WAV parsing rejects truncated, contradictory and unsupported audio', async () => {
  const wav = Buffer.from(await DKAudioCodec.wav([new Uint8Array(1600)]).arrayBuffer());
  const mutations = [
    (b) => b.writeUInt32LE(b.length, 4),
    (b) => b.writeUInt32LE(1602, 40),
    (b) => b.writeUInt32LE(1598, 40),
    (b) => b.writeUInt32LE(1599, 40),
    (b) => b.writeUInt16LE(3, 20),
    (b) => b.writeUInt16LE(2, 22),
    (b) => b.writeUInt32LE(48000, 24),
    (b) => b.writeUInt32LE(32001, 28),
    (b) => b.writeUInt16LE(1, 32),
    (b) => b.writeUInt16LE(8, 34),
  ];
  for (const edit of mutations)
    await assert.rejects(DKAudioCodec.validateWav(malformed(wav, edit)), {
      code: 'audio_integrity',
    });
});

test('padded metadata is accepted and validation never reads the PCM body', async () => {
  const basic = Buffer.from(await DKAudioCodec.wav([new Uint8Array(1600)]).arrayBuffer());
  const junk = Buffer.alloc(12);
  junk.write('JUNK');
  junk.writeUInt32LE(3, 4);
  junk.set([11, 12, 13], 8);
  const bytes = Buffer.concat([basic.subarray(0, 36), junk, basic.subarray(36)]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  const blob = new Blob([bytes]);
  const slice = blob.slice.bind(blob);
  let read = 0;
  blob.slice = (start, end) => {
    assert(end <= 56);
    read += end - start;
    return slice(start, end);
  };
  assert.deepEqual(await DKAudioCodec.validateWav(blob), { start: 56, bytes: 1600, samples: 800 });
  assert.equal(read, 52, 'validation cost depends on headers, not recording duration');
});

test('short or rejected native Blob reads retry without changing source bytes', async () => {
  const original = DKAudioCodec.wav([new Uint8Array(1600).fill(37)]);
  const nativeRead = Blob.prototype.arrayBuffer;
  const oldReader = globalThis.FileReader;
  let fallbackReads = 0;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      fallbackReads++;
      nativeRead.call(blob).then(result => { this.result = result; this.onload(); });
    }
  };
  try {
    for (const mode of ['short', 'throws']) {
      const source = new Blob([original]);
      const nativeSlice = source.slice.bind(source);
      source.slice = (...args) => {
        const slice = nativeSlice(...args);
        slice.arrayBuffer = async () => {
          if (mode === 'throws') throw new RangeError('Out of bounds access');
          return new ArrayBuffer(0);
        };
        return slice;
      };
      assert.deepEqual(await DKAudioCodec.validateWav(source), { start: 44, bytes: 1600, samples: 800 });
      source.arrayBuffer = async () => new ArrayBuffer(1600);
      assert.deepEqual(await DKAudioCodec.readBlob(source), await original.arrayBuffer());
    }
    assert.equal(fallbackReads, 10);
  } finally { globalThis.FileReader = oldReader; }
});

test('unreadable stored PCM cannot become an empty or truncated upload', async () => {
  const blob = new Blob([new Uint8Array(1600)]);
  blob.arrayBuffer = async () => new ArrayBuffer(800);
  await assert.rejects(DKAudioCodec.readBlob(blob), { code: 'audio_read', retryable: true, expectedBytes: 1600, actualBytes: 800 });
  const store = new DKAudioStore();
  store.get = async () => ({ pcmBlob: blob, frameCount: 1 });
  await assert.rejects(store.segment('r', 0), { code: 'audio_read' });
  assert.equal(blob.size, 1600);
});
