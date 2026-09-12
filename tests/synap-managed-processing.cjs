'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const signedIn of [true, false]) {
  test(`managed queue keeps deployment settings transient (signed in: ${signedIn})`, async () => {
    const context = {
      console,
      URL,
      setTimeout,
      clearTimeout,
      AbortController,
      SynapAuth: {
        isSignedIn: () => signedIn,
        config: () => ({ backendUrl: 'https://api.example.test' }),
      },
      localStorage: {
        getItem: () => null,
        setItem: () => assert.fail('queue wrote user preferences'),
      },
    };
    vm.createContext(context);
    for (const file of ['processing-queue.js', 'synap-backend.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    }
    const messages = [];
    const original = { endpoint: '', llmEndpoint: '', autoProcess: true };
    let selections = 0;
    const queue = new context.DKFIFOProcessor(
      {
        nextRunnable: async () => {
          selections++;
          return { job: null };
        },
      },
      {
        settings: () => original,
        provider: () => 'synap',
        locks: { request: async (_name, _options, callback) => callback({}) },
        onChange: (message) => messages.push(message),
      },
    );
    await queue.resume();
    assert.equal(queue.settings(), original);
    assert.equal(original.endpoint, '');
    assert.equal(queue.running, false);
    if (signedIn) assert.ok(selections > 0, 'signed-in work enters the durable queue');
    else {
      assert.equal(selections, 0, 'signed-out work stays pending');
      assert.match(messages.join(' '), /Sign in with Google/);
    }
  });
}
