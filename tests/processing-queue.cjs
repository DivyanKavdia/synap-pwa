'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}, runtime = {}) {
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
    ...runtime,
  };
  vm.createContext(context);
  for (const file of ['audio-store.js', 'memory-ready-events.js', 'processing-queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  const jobs = [
    { id: 1, recordingId: 'r1', kind: 'consolidate', state: 'pending', segmentIndex: 0 },
  ];
  const store = {
    get: async (_table, id) => ({ id }),
    recoveryFailures: new Map(),
    all: async (_table, index, id) => index === 'recording' ? jobs.filter(job => job.recordingId === id) : jobs,
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

test('expired job budget is a retryable timeout rather than a user cancellation', async () => {
  let expire;
  const h = fixture({}, { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} });
  h.queue.paused = false;
  const pending = h.queue.withJobSignal(h.jobs[0], 120000, signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError', audioStage: 'sending upload' })));
  }));
  expire();
  await assert.rejects(pending, { name: 'TimeoutError', code: 'processing_timeout', retryable: true, audioStage: 'sending upload' });
  assert.equal(h.queue.controllers.size, 0);
});

test('pausing an older exhausted job never turns cancellation into another permanent failure', async () => {
  const h = fixture();
  h.jobs[0].attempts = 5;
  h.queue.process = async () => { throw Object.assign(new Error('Paused'), { name: 'AbortError' }); };
  await h.queue.execute(h.jobs[0], {}, 'https://fixture.test');
  assert.equal(h.jobs[0].state, 'pending');
  assert.equal(h.jobs[0].attempts, 5);
  assert.match(h.messages.at(-1), /Processing paused/);
});

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

test('model failure diagnostics keep the stage and status without repeating a permanent rejection', async () => {
  const { queue, context, jobs, messages } = fixture({ provider: () => 'model-fixture' });
  let calls = 0;
  context.DKFIFOProcessor.registerProvider('model-fixture', {
    process: async () => {
      calls++;
      throw Object.assign(new Error('Saved audio is retained.'), {
        retryable: false, audioStage: 'transcribing saved audio', code: 'model_request_rejected', status: 502, providerStatus: 400,
      });
    },
  });
  await queue.resume();
  assert.equal(calls, 1);
  assert.equal(jobs[0].state, 'failed');
  assert.equal(jobs[0].failureDetail.code, 'model_request_rejected');
  assert.equal(jobs[0].failureDetail.providerStatus, 400);
  assert(messages.some(message => message.includes('transcribing saved audio') && message.includes('provider HTTP 400')));
});

test('rate limits back off without consuming the recording failure budget', async (t) => {
  let now = 1000, calls = 0, advice = 0;
  const { queue, context, jobs, messages } = fixture({ provider: () => 'rate-fixture', now: () => now });
  t.after(() => queue.pause());
  jobs[0].attempts = 4;
  context.DKFIFOProcessor.registerProvider('rate-fixture', {
    process: async () => {
      calls++;
      throw Object.assign(new Error('Saved audio is retained.'), {
        code: 'model_rate_limited', status: 503, providerStatus: 429, retryable: true, retryAfterMs: advice,
      });
    },
  });
  for (const delay of [60000,120000,240000,480000,900000,900000]) {
    await queue.resume();
    await queue.pause();
    assert.equal(jobs[0].state, 'pending');
    assert.equal(jobs[0].attempts, 4);
    assert.equal(jobs[0].nextAt, now + delay);
    now = jobs[0].nextAt;
  }
  advice = 3600000;
  await queue.resume();
  assert.equal(jobs[0].nextAt, now + advice);
  assert.equal(calls, 7);
  assert(messages.some(message => message.includes('Retrying in 60 seconds')));
});

test('a persisted cooldown survives reload and selected Retry while completed segments stay done', async (t) => {
  let now = 1000;
  const original = fixture({ provider: () => 'rate-fixture', now: () => now });
  original.context.DKFIFOProcessor.registerProvider('rate-fixture', {
    prepare: async (_queue, config) => ({ ...config, accountUid: 'alice' }),
    process: async () => { throw Object.assign(new Error('Wait'), { code: 'model_rate_limited', retryAfterMs: 90000 }); },
  });
  t.after(() => original.queue.pause());
  await original.queue.resume();
  await original.queue.pause();
  const reloaded = fixture({ provider: () => 'rate-fixture', now: () => now });
  t.after(() => reloaded.queue.pause());
  reloaded.jobs.splice(0, 1, JSON.parse(JSON.stringify(original.jobs[0])),
    { id: 2, recordingId: 'r2', kind: 'consolidate', segmentIndex: 0, state: 'pending' },
    { id: 3, recordingId: 'r1', kind: 'transcribe', segmentIndex: 0, state: 'done' });
  const calls = [];
  reloaded.context.DKFIFOProcessor.registerProvider('rate-fixture', {
    prepare: async (_queue, config) => ({ ...config, accountUid: 'alice' }),
    process: async (_queue, job) => { calls.push(job.id); return {}; },
  });
  await reloaded.queue.retryRecording('r1');
  await reloaded.queue.settled;
  assert.equal(reloaded.jobs[0].nextAt, 0, 'Retry resets the job delay');
  assert.deepEqual(calls, [], 'the durable provider cooldown still applies');
  await reloaded.queue.retryRecording('r2');
  await reloaded.queue.settled;
  assert.deepEqual(calls, [], 'selecting a different recording cannot bypass the limit');
  now = 91000;
  await reloaded.queue.resume();
  assert.deepEqual(calls.sort(), [1, 2]);
  assert(reloaded.jobs.every(job => job.state === 'done'));
});

test('a saved cooldown is scoped to its provider and account', async (t) => {
  for (const [provider, accountUid] of [['rate-fixture','bob'], ['another-provider','alice']]) {
    const { queue, context, jobs } = fixture({ provider: () => provider, now: () => 1000 });
    t.after(() => queue.pause());
    Object.assign(jobs[0], { providerCooldownKey: 'rate-fixture:alice', providerCooldownUntil: 91000 });
    context.DKFIFOProcessor.registerProvider(provider, {
      prepare: async (_queue, config) => ({ ...config, accountUid }),
      process: async () => ({}),
    });
    await queue.resume();
    assert.equal(jobs[0].state, 'done');
  }
});

test('a 429 drains existing requests but prevents launching another recording', async (t) => {
  const { queue, context, jobs } = fixture({ provider: () => 'rate-fixture', now: () => 1000 });
  t.after(() => queue.pause());
  jobs.push(...[2,3].map(id => ({ id, recordingId: 'r' + id, kind: 'consolidate', state: 'pending', segmentIndex: 0 })));
  const calls = [], pending = new Map();
  context.DKFIFOProcessor.registerProvider('rate-fixture', {
    process: (_queue, job) => new Promise((resolve, reject) => {
      calls.push(job.id); pending.set(job.id, { resolve, reject });
    }),
  });
  const running = queue.resume();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [1, 2]);
  pending.get(1).reject(Object.assign(new Error('Wait'), { status: 429 }));
  await new Promise(setImmediate);
  assert.deepEqual(calls, [1, 2]);
  pending.get(2).resolve({});
  await running;
  assert.deepEqual(calls, [1, 2]);
  assert.equal(jobs[0].state, 'pending');
  assert.equal(jobs[1].state, 'done');
  assert.equal(jobs[2].state, 'pending');
});

test('pause aborts provider work and leaves it pending without spending a retry', async () => {
  const { queue, context, jobs, events, messages } = fixture({ provider: () => 'fixture' });
  let started;
  const working = new Promise((resolve) => {
    started = resolve;
  });
  context.DKFIFOProcessor.registerProvider('fixture', {
    process: (_queue, _job, _config, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('Synap request cancelled.'), { name: 'AbortError', audioStage: 'sending upload' })),
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
  assert.equal(jobs[0].lastError, '');
  assert.equal(jobs[0].failureDetail, null);
  assert(messages.includes('Processing paused; saved audio is retained.'));
  assert(!messages.some(message => /failed|retry scheduled/.test(message)), 'an intentional cancellation is not an upload failure');
  assert.deepEqual(
    events.map((event) => event.detail.state),
    ['running', 'pending'],
  );
});

test('an upload interrupted for OTA resumes the same selected job after the lock is released', async () => {
  let firmwareBusy=false;
  const { queue, context, jobs, store } = fixture({ provider: () => 'fixture', canRun: () => !firmwareBusy });
  jobs[0].kind='transcribe';jobs[0].attempts=2;jobs[0].dedupe='r1:transcribe:0';
  jobs.push({id:2,recordingId:'r2',kind:'transcribe',state:'pending',segmentIndex:0});
  const submissions=[];let working;
  const started=new Promise(resolve=>{working=resolve;});
  context.DKFIFOProcessor.registerProvider('fixture', {
    process: (_queue, job, _config, signal) => {
      submissions.push([job.id,job.recordingId,job.dedupe]);
      if(submissions.length>1)return Promise.resolve({transcript:'Recovered transcript'});
      working();
      return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(
        Object.assign(new Error('Cancelled for update'),{name:'AbortError',audioStage:'sending upload'})
      ),{once:true}));
    },
  });
  const running=queue.resume(['r1']);await started;
  firmwareBusy=true;
  await queue.pause('Queue paused for firmware update');await running;
  assert.equal(jobs[0].state,'pending');assert.equal(jobs[0].attempts,2);assert.equal(jobs[0].nextAt,0);
  await queue.resume(['r1']);assert.equal(submissions.length,1,'the firmware lock still prevents submissions');
  const finish=store.finishJob;let transcript;
  store.finishJob=async(job,output)=>{transcript=output.transcript;return finish(job,output);};
  firmwareBusy=false;await queue.resume(['r1']);
  assert.deepEqual(submissions,[[1,'r1','r1:transcribe:0'],[1,'r1','r1:transcribe:0']]);
  assert.equal(transcript,'Recovered transcript');assert.equal(jobs[0].state,'done');
  assert.equal(jobs[1].state,'pending','resumption keeps the selected recording scope');
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

for (const provider of ['custom', 'fixture']) test('local soundtrack cannot enter ' + provider + ' processing, including stale jobs', async () => {
  const { queue, context, store, jobs, events } = fixture({provider: () => provider,
    fetch: () => assert.fail('local audio must never be uploaded')});
  store.get = async () => ({ id: 'r1', localOnly: true });
  context.DKFIFOProcessor.registerProvider('fixture', {
    process: () => assert.fail('no adapter receives a local soundtrack'),
  });
  await queue.resume();
  assert.equal(jobs[0].state, 'done');
  assert(!events.some(event => event.type === 'synap-memory-ready'));
});
