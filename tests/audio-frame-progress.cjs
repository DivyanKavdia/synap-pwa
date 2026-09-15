'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
function collector() {
  let now = 10000;
  const c = {
    DataView,
    Uint8Array,
    Map,
    Set,
    Math,
    performance: { now: () => now },
    AUDIO_HEADER_BYTES: 8,
    AUDIO_MAGIC: 0xa5,
    PROTOCOL_VERSION: 2,
    MIN_CHUNKS_PER_FRAME: 1,
    MAX_CHUNKS_PER_FRAME: 20,
    MAX_AUDIO_PAYLOAD_BYTES: 500,
    PCM_BYTES_PER_FRAME: 1600,
    RECENT_FRAME_WINDOW: 4096,
    INCOMPLETE_FRAME_TIMEOUT_MS: 900,
    appState: 'recording',
    pendingFrames: new Map(),
    completedSequences: new Set(),
    completedPcmFrames: [],
    lastObservedSequence: null,
    lastFrameCleanupAt: 0,
    journal: null,
    sessionStats: {
      firstSequence: null,
      completeFrames: 0,
      pcmBytes: 0,
      packetsReceived: 0,
      invalidPackets: 0,
      duplicatePackets: 0,
      incompleteFrames: 0,
      missingFrames: 0,
    },
    log() {},
    updateMetrics() {},
    recordCompleteAudio() {},
  };
  vm.createContext(c);
  vm.runInContext(
    source.slice(
      source.indexOf('  function handleNormalizedAudioValue('),
      source.indexOf('  function updateAudioLevel('),
    ),
    c,
  );
  c.updateAudioLevel = () => {};
  const pcm = Uint8Array.from({ length: 1600 }, (_, i) => i % 251);
  function send(chunk, sequence = 7) {
    const v = new DataView(new ArrayBuffer(168));
    v.setUint8(0, 0xa5);
    v.setUint8(1, 2);
    v.setUint16(2, sequence, true);
    v.setUint8(4, chunk);
    v.setUint8(5, 10);
    v.setUint16(6, 160, true);
    new Uint8Array(v.buffer, 8).set(pcm.subarray(chunk * 160, (chunk + 1) * 160));
    c.handleNormalizedAudioValue(v, 'pcm16');
  }
  return {
    c,
    pcm,
    send,
    advance(ms) {
      now += ms;
    },
  };
}
test('slow but progressing PCM fragments finish with every original byte', () => {
  const t = collector();
  // A congested MTU185 frame takes 1.8 seconds; each fragment is still making progress.
  for (let chunk = 0; chunk < 10; chunk++) {
    t.send(chunk);
    t.advance(200);
  }
  assert.equal(t.c.sessionStats.completeFrames, 1);
  assert.equal(t.c.sessionStats.incompleteFrames, 0);
  assert.deepEqual(t.c.completedPcmFrames[0], t.pcm);
});
test('duplicate fragments cannot keep an abandoned PCM frame alive', () => {
  const t = collector();
  t.send(0);
  t.advance(600);
  t.send(0);
  t.advance(301);
  t.c.cleanupStaleFrames(false);
  assert.equal(t.c.pendingFrames.size, 0);
  assert.equal(t.c.sessionStats.incompleteFrames, 1);
  assert.equal(t.c.sessionStats.completeFrames, 0);
});
test('a genuinely stalled or explicitly flushed partial frame is removed', () => {
  const t = collector();
  t.send(0);
  t.advance(200);
  t.send(1);
  t.advance(901);
  t.c.cleanupStaleFrames(false);
  assert.equal(t.c.pendingFrames.size, 0);
  t.send(0, 8);
  t.c.cleanupStaleFrames(true);
  assert.equal(t.c.pendingFrames.size, 0);
  assert.equal(t.c.sessionStats.incompleteFrames, 2);
});
test('a fragment after an idle timeout cannot revive the abandoned frame', () => {
  const t = collector();
  t.send(0);
  t.advance(901);
  t.send(1);
  assert.equal(t.c.sessionStats.incompleteFrames, 1);
  assert.equal(t.c.pendingFrames.get(7).receivedChunks, 1);
  assert.equal(t.c.pendingFrames.get(7).chunks[0], undefined);
});
