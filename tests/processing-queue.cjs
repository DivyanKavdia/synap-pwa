'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
  const events = [],
    messages = [];
  const context = {
    console,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    dispatchEvent: (event) => events.push(event),
  };
  vm.createContext(context);
  for (const file of ['audio-store.js', 'memory-ready-events.js', 'processing-queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  const jobs = [
    { id: 1, recordingId: 'r1', kind: 'consolidate', state: 'pending', segmentIndex: 0 },
  ];
  const store = {
    recoveryFailures: new Map(),
    all: async () => jobs,
    nextRunnable: context.DKAudioStore.prototype.nextRunnable,
    patchJob: async (id, fields) =>
      Object.assign(
        jobs.find((job) => job.id === id),
        fields,
      ),
    finishJob: async (job, output) => {
      job.state = 'done';
      return { id: job.recordingId, processingState: 'done', ...output };
    },
  };
  const queue = new context.DKFIFOProcessor(store, {
    settings: () => ({
      endpoint: 'https://fixture.test/stt',
      llmEndpoint: 'https://fixture.test/llm',
    }),
    locks: { request: async (_name, _options, callback) => callback({}) },
    onChange: (message) => messages.push(message),
    ...options,
  });
  return { context, queue, store, jobs, events, messages };
}

test('missing endpoints stop the queue without selecting the same pending job forever', async () => {
  const { queue, store, jobs, messages } = fixture({ settings: () => ({}) });
  let selections = 0;
  const select = store.nextRunnable;
  store.nextRunnable = function (...args) {
    assert.ok(++selections < 4, 'missing configuration must return to the caller');
    return select.apply(this, args);
  };
  await queue.resume();
  assert.equal(selections, 1);
  assert.equal(queue.running, false);
  assert.equal(jobs[0].state, 'pending');
  assert.match(messages.at(-1), /configure LLM endpoint/);
});

test('provider selection stays stable until the current run settles', async () => {
  let selected = 'first';
  const { queue, context, jobs } = fixture({ provider: () => selected });
  jobs.push({ id: 2, recordingId: 'r1', kind: 'consolidate', state: 'pending', segmentIndex: 1 });
  const calls = [];
  context.DKFIFOProcessor.registerProvider('first', {
    process: async (_queue, job) => {
      calls.push(job.id);
      selected = 'second';
      return {};
    },
  });
  context.DKFIFOProcessor.registerProvider('second', {
    process: () => assert.fail('provider changed during a run'),
  });
  await queue.resume();
  assert.deepEqual(calls, [1, 2]);
});

test('completion events wait for the durable commit and deduplicate the saved memory', async () => {
  const { queue, context, store, events } = fixture({ provider: () => 'fixture' });
  context.DKFIFOProcessor.registerProvider('fixture', {
    process: async () => ({ summary: 'Saved' }),
  });
  let commit;
  const committed = new Promise((resolve) => {
    commit = resolve;
  });
  let saving;
  const startedSaving = new Promise((resolve) => {
    saving = resolve;
  });
  const originalFinish = store.finishJob;
  store.finishJob = async (...args) => {
    saving();
    await committed;
    return originalFinish(...args);
  };
  const running = queue.resume();
  await startedSaving;
  assert.deepEqual(
    events.map((event) => event.detail.state),
    ['running'],
  );
  commit();
  await running;
  assert.deepEqual(
    events.map((event) => event.type),
    ['synap-processing-state', 'synap-processing-state', 'synap-memory-ready'],
  );
  assert.equal(events[1].detail.state, 'done');
  context.SynapMemoryReadyEvents.emit({ id: 'r1', processingState: 'done' });
  assert.equal(events.length, 3);
});

test('a failed local commit never announces a ready memory', async () => {
  const { queue, context, store, jobs, events } = fixture({ provider: () => 'fixture' });
  context.DKFIFOProcessor.registerProvider('fixture', {
    process: async () => ({ summary: 'Unsaved' }),
  });
  store.finishJob = async () => {
    throw Object.assign(new Error('Storage full'), { retryable: false });
  };
  await queue.resume();
  assert.equal(jobs[0].state, 'failed');
  assert.deepEqual(
    events.map((event) => event.detail.state),
    ['running', 'failed'],
  );
});

test('pause aborts provider work and leaves it pending without spending a retry', async () => {
  const { queue, context, jobs, events } = fixture({ provider: () => 'fixture' });
  let started;
  const working = new Promise((resolve) => {
    started = resolve;
  });
  context.DKFIFOProcessor.registerProvider('fixture', {
    process: (_queue, _job, _config, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('Paused'), { name: 'AbortError' })),
          { once: true },
        );
        started();
      }),
  });
  const running = queue.resume();
  await working;
  await queue.pause();
  await running;
  assert.equal(jobs[0].state, 'pending');
  assert.equal(jobs[0].attempts, 0);
  assert.equal(queue.controllers.size, 0);
  assert.deepEqual(
    events.map((event) => event.detail.state),
    ['running', 'pending'],
  );
});

test('a failed UI callback cannot requeue a committed memory', async () => {
  const { queue, context, jobs, events } = fixture({
    provider: () => 'fixture',
    onChange: (message) => {
      if (message.startsWith('Saved job')) throw new Error('UI failed');
    },
  });
  context.DKFIFOProcessor.registerProvider('fixture', {
    process: async () => ({ summary: 'Saved' }),
  });
  await queue.resume();
  assert.equal(jobs[0].state, 'done');
  assert.equal(events.filter((event) => event.type === 'synap-memory-ready').length, 1);
});
