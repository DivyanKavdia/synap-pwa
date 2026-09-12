/* Real shell, IndexedDB transactions and queue dispatch; deterministic provider responses. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(path.resolve(__dirname, '..'));

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => document.body.dataset.startup === 'ready');
    const result = await page.evaluate(async () => {
      const store = new DKAudioStore(),
        id = 'queue-fixture',
        calls = [],
        ready = [];
      await store.atomic(['recordings', 'segments', 'jobs'], (tables) => {
        tables.recordings.put({
          id,
          name: 'Queue fixture',
          createdAt: new Date().toISOString(),
          sealed: true,
          status: 'saved',
        });
        tables.segments.put({ recordingId: id, index: 0, frameCount: 1 });
        for (const kind of ['transcribe', 'summarize', 'consolidate']) {
          tables.jobs.add({
            recordingId: id,
            segmentIndex: 0,
            kind,
            state: 'pending',
            dedupe: id + ':' + kind,
          });
        }
      });
      DKFIFOProcessor.registerProvider('fixture', {
        process: async (_queue, job) => {
          calls.push(job.kind);
          if (job.kind === 'transcribe') return { transcript: 'A durable conversation.' };
          const segment = await store.get('segments', [id, 0]);
          if (segment.transcript !== 'A durable conversation.')
            throw Error('Prior transcript was not committed');
          return {
            summary: 'Saved memory.',
            ...(job.kind === 'consolidate'
              ? { transcript: segment.transcript, processingState: 'done' }
              : {}),
          };
        },
      });
      addEventListener('synap-memory-ready', (event) => {
        if (event.detail.recordingId === id) ready.push(store.get('recordings', id));
      });
      const queue = new DKFIFOProcessor(store, {
        provider: () => 'fixture',
        settings: () => ({
          endpoint: 'https://fixture.invalid/stt',
          llmEndpoint: 'https://fixture.invalid/llm',
        }),
      });
      await queue.resume([id]);
      const saved = await store.get('recordings', id),
        jobs = await store.all('jobs', 'recording', id);
      return { calls, saved, jobs, announced: await Promise.all(ready), running: queue.running };
    });
    assert.deepEqual(result.calls, ['transcribe', 'summarize', 'consolidate']);
    assert(result.jobs.every((job) => job.state === 'done'));
    assert.equal(result.saved.summary, 'Saved memory.');
    assert(result.saved.processedAt);
    assert.equal(result.announced.length, 1);
    assert.deepEqual(result.announced[0], result.saved);
    assert.equal(result.running, false);
    assert.deepEqual(errors, []);
    console.log(
      'PASS processing: ordered jobs, durable transcript/summary, one post-commit memory event',
    );
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
