'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../recording/timeline.js');
require('../audio-store.js');

const packet = (sequence) => ({
  sequence,
  chunk: 0,
  total: 1,
  payload: new Uint8Array(1600).fill(7),
});

test('late packets before the recording origin cannot replace its first audio frame', () => {
  const store = new DKAudioStore({ timeline: new SynapRecordingTimeline() });
  store.append('take', packet(42));
  store.append('take', packet(41));
  store.append('take', packet(43));
  clearTimeout(store.timer);
  assert.deepEqual(
    store.buffer.map((p) => p.sequence),
    [0, 1],
  );
});

test('close takes ownership immediately, coalesces callers and keeps failed audio retryable', async () => {
  const store = new DKAudioStore({ timeline: new SynapRecordingTimeline() });
  store.append('take', packet(900));
  clearTimeout(store.timer);
  let release,
    seals = 0;
  store.rollingWork = new Promise((resolve) => {
    release = resolve;
  });
  store.sealRecording = async () => {
    seals++;
    throw Error('Disk full');
  };
  const first = store.close('take'),
    second = store.close('take');
  assert.throws(() => store.append('take', packet(901)), /closing or saved/);
  const failures = Promise.all([
    assert.rejects(first, /Disk full/),
    assert.rejects(second, /Disk full/),
  ]);
  release();
  await failures;
  assert.equal(seals, 1);
  assert.equal(store.buffer.length, 1, 'a failed seal keeps buffered PCM');
  assert.equal(
    store.timeline.relativeSequence('take', 901),
    1,
    'failed close retains the same origin',
  );
  store.sealRecording = async () => {
    seals++;
    return { id: 'take', sealed: true };
  };
  assert.equal((await store.close('take')).sealed, true);
  assert.equal(seals, 2);
  assert.equal(store.timeline.sequences.has('take'), false, 'only success releases the timeline');
  assert.throws(() => store.append('take', packet(902)), /closing or saved/);
});

test('deletion waits for pending compaction and flush before removing durable rows', async () => {
  const store = new DKAudioStore(),
    calls = [];
  let release;
  store.rollingWork = new Promise((resolve) => {
    release = () => {
      calls.push('window');
      resolve();
    };
  });
  store.flush = async () => {
    calls.push('flush');
  };
  store.atomic = async () => {
    calls.push('delete');
  };
  const deletion = store.remove('take');
  assert.throws(() => store.append('take', packet(0)), /closing or saved/);
  assert.deepEqual(calls, []);
  release();
  await deletion;
  assert.deepEqual(calls, ['window', 'flush', 'delete']);
});

test('loading capture configuration leaves existing store methods untouched', () => {
  const methods = ['begin', 'append', 'close', 'remove'].map(
    (name) => DKAudioStore.prototype[name],
  );
  require('../recording/journal.js');
  assert.deepEqual(
    ['begin', 'append', 'close', 'remove'].map((name) => DKAudioStore.prototype[name]),
    methods,
  );
  const logical = new DKAudioStore(SynapRecordingJournal.options());
  logical.append('desktop', packet(65536));
  clearTimeout(logical.timer);
  assert.equal(logical.buffer[0].sequence, 65536, 'desktop counters remain logical beyond uint16');
});
