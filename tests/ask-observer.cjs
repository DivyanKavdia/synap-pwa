'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ask-synap.js'), 'utf8');

function harness({ late = false } = {}) {
  const observers = [], frames = [], authListeners = [];
  let signedIn = false, scheduledFrames = 0;

  function emit(target) {
    for (const observer of observers) {
      const direct = observer.target === target;
      let descendant = false;
      for (let parent = target.parentNode; parent; parent = parent.parentNode) {
        if (parent === observer.target) descendant = true;
      }
      if (observer.options.childList && (direct || (observer.options.subtree && descendant))) {
        observer.records.push({ type: 'childList', target });
      }
    }
  }

  class Node {
    constructor(name, id = '', className = '') {
      this.name = name;
      this.id = id;
      this.className = className;
      this.dataset = {};
      this.children = [];
      this.parentNode = null;
      this.value = '';
      this.writes = 0;
    }
    append(node) {
      node.parentNode = this;
      this.children.push(node);
      emit(this);
    }
    get textContent() { return this.value; }
    set textContent(value) {
      this.value = String(value);
      this.writes++;
      emit(this);
    }
    querySelector(selector) {
      for (const child of this.children) {
        if (selector === '#' + child.id || selector === '.' + child.className || selector === child.name) return child;
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    }
  }

  const body = new Node('body'), main = new Node('main');
  const library = new Node('section', 'library'), ask = new Node('section', 'ask');
  const copy = new Node('p', '', 'section-copy');
  body.append(main);
  main.append(library);
  ask.append(copy);
  if (!late) main.append(ask);

  const context = {
    document: { readyState: 'complete', body, querySelector: selector => body.querySelector(selector), addEventListener() {} },
    SynapAuth: {
      isSignedIn: () => signedIn,
      config: () => ({ backendUrl: 'https://synap.invalid' }),
      onChange: listener => authListeners.push(listener)
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; }
      observe(target, options) { this.target = target; this.options = options; observers.push(this); }
    },
    requestAnimationFrame(callback) { scheduledFrames++; frames.push(callback); },
    setTimeout() {},
    console
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'ask-synap.js' });

  function settle() {
    for (let round = 0; round < 20; round++) {
      const pending = observers.filter(observer => observer.records.length);
      if (!pending.length && !frames.length) return;
      for (const observer of pending) observer.callback(observer.records.splice(0));
      const next = frames.splice(0);
      for (const callback of next) callback();
    }
    assert.fail('Ask copy mutations kept scheduling animation frames after inputs stopped changing');
  }

  return {
    Node, main, library, ask, copy, settle,
    get scheduledFrames() { return scheduledFrames; },
    signIn(value) { signedIn = value; for (const listener of authListeners) listener(); }
  };
}

test('unrelated descendant changes do not write Ask copy or schedule animation frames', () => {
  const app = harness();
  app.settle();
  const writes = app.copy.writes, frames = app.scheduledFrames;
  const transcript = new app.Node('p');
  app.library.append(transcript);
  transcript.textContent = 'A recording finished processing.';
  app.settle();
  assert.equal(app.copy.writes, writes);
  assert.equal(app.scheduledFrames, frames);

  // Direct section insertion can rescan, but unchanged copy must remain untouched.
  app.main.append(new app.Node('section', 'peopleMemory'));
  app.settle();
  assert.equal(app.copy.writes, writes);
});

test('Ask inserted after startup receives its local copy and settles without a loop', () => {
  const app = harness({ late: true });
  app.main.append(app.ask);
  app.settle();
  assert.equal(app.ask.dataset.askMode, 'local');
  assert.match(app.copy.textContent, /Ask locally from memories on this device/);
  assert.doesNotMatch(app.copy.textContent, /\bSynap\b/, 'copy must agree with the runtime brand normalizer');
  assert.equal(app.copy.writes, 1);
});

test('auth changes update Ask copy once per mode and repeated notifications are idempotent', () => {
  const app = harness();
  app.signIn(true);
  app.settle();
  assert.equal(app.ask.dataset.askMode, 'cloud');
  assert.match(app.copy.textContent, /processed synap memories/);
  assert.equal(app.copy.writes, 2);

  app.signIn(true);
  app.settle();
  assert.equal(app.copy.writes, 2);

  app.signIn(false);
  app.settle();
  assert.equal(app.ask.dataset.askMode, 'local');
  assert.equal(app.copy.writes, 3);
});
