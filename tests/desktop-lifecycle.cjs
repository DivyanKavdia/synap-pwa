'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm'),
  fs = require('node:fs');
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function harness() {
  const displayPrompt = deferred(),
    close = deferred(),
    tracks = [],
    events = [],
    frames = [];
  let opens = 0,
    closes = 0,
    failSave = false;
  function stream() {
    const track = {
      stopped: false,
      handlers: [],
      stop() {
        this.stopped = true;
      },
      addEventListener(_, fn) {
        this.handlers.push(fn);
      },
    };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  }
  const display = stream(),
    mic = stream();
  const node = () => ({
    gain: {},
    connect(next) {
      return next;
    },
    disconnect() {},
  });
  let processor;
  class AudioContext {
    constructor() {
      this.sampleRate = 16000;
      this.state = 'running';
      this.destination = {};
    }
    createGain() {
      return node();
    }
    createMediaStreamSource() {
      return node();
    }
    createScriptProcessor() {
      processor = node();
      return processor;
    }
    async close() {
      this.state = 'closed';
    }
  }
  class Store {
    async open() {
      opens++;
    }
    async begin() {
      return 'meeting';
    }
    async atomic() {}
    async remove() {}
    append(id, frame) {
      frames.push({ id, frame });
    }
    async close() {
      closes++;
      if (failSave) {
        failSave = false;
        throw Error('Quota exceeded');
      }
      return close.promise;
    }
  }
  const c = {
    console: { warn() {} },
    Date,
    Error,
    Promise,
    Float32Array,
    Uint8Array,
    DataView,
    Math,
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById() {
        return null;
      },
      body: { dataset: { state: 'disconnected' } },
    },
    navigator: {
      mediaDevices: { getDisplayMedia: () => displayPrompt.promise, getUserMedia: async () => mic },
    },
    AudioContext,
    MediaStream: class {},
    DKAudioStore: Store,
    SynapRecordingJournal: { options: () => ({}) },
    localStorage: { getItem: () => '{}' },
    setTimeout() {},
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    dispatchEvent: (event) => events.push(event.type),
    location: {},
  };
  c.globalThis = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync('desktop-capture.js', 'utf8'), c);
  return {
    c,
    tracks,
    events,
    frames,
    close,
    allow: () => displayPrompt.resolve(display),
    deny: () => displayPrompt.reject(Error('Permission denied')),
    failSave: () => {
      failSave = true;
    },
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
    audio() {
      processor.onaudioprocess({
        inputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(850).fill(0.2) },
      });
    },
  };
}
test('meeting ownership begins before permissions resolve; duplicate starts are rejected', async () => {
  const h = harness(),
    first = h.c.SynapDesktopCapture.start();
  assert.equal(h.c.SynapDesktopCapture.state().phase, 'starting');
  await assert.rejects(h.c.SynapDesktopCapture.start(), /already running/);
  assert.equal(h.opens, 0);
  h.allow();
  await first;
  assert.equal(h.opens, 1);
  assert.equal(h.c.SynapDesktopCapture.state().phase, 'recording');
  h.close.resolve({ durationMs: 50 });
  await h.c.SynapDesktopCapture.stop();
});
test('permission rejection and cancelled setup release ownership without a source recording', async () => {
  for (const cancel of [false, true]) {
    const h = harness(),
      first = h.c.SynapDesktopCapture.start();
    if (cancel) {
      await h.c.SynapDesktopCapture.stop();
      h.allow();
    } else h.deny();
    await assert.rejects(first);
    assert.equal(h.c.SynapDesktopCapture.state().active, false);
    assert.equal(h.opens, 0);
    if (cancel) assert(h.tracks[0].stopped);
  }
});
test('a pendant starting during setup prevents meeting audio from being captured', async () => {
  const h = harness(),
    first = h.c.SynapDesktopCapture.start();
  h.c.document.body.dataset.state = 'recording';
  h.allow();
  await assert.rejects(first, /pendant recording started/);
  assert.equal(h.opens, 0);
  assert(h.tracks[0].stopped);
});
test('stop coalesces callers, releases media promptly and retains failed audio for retry', async () => {
  const h = harness(),
    started = h.c.SynapDesktopCapture.start();
  h.allow();
  await started;
  h.audio();
  assert.equal(h.frames.length, 1);
  h.failSave();
  await assert.rejects(h.c.SynapDesktopCapture.stop(), /Quota exceeded/);
  assert.equal(h.c.SynapDesktopCapture.state().phase, 'save-failed');
  assert(h.tracks.every((track) => track.stopped));
  assert(!h.events.includes('synap-desktop-capture-stopped'));
  assert.equal(h.frames.length, 2, 'one padded tail is retained');
  await assert.rejects(h.c.SynapDesktopCapture.start(), /already running/);
  const first = h.c.SynapDesktopCapture.stop(),
    second = h.c.SynapDesktopCapture.stop();
  assert.equal(first, second);
  assert.equal(h.c.SynapDesktopCapture.state().phase, 'saving');
  await tick();
  assert.equal(h.closes, 2);
  h.close.resolve({ durationMs: 100, createdAt: new Date().toISOString() });
  await first;
  assert.equal(h.c.SynapDesktopCapture.state().active, false);
  assert.equal(h.frames.length, 2);
  assert.equal(h.events.filter((event) => event === 'synap-desktop-capture-stopped').length, 1);
});
