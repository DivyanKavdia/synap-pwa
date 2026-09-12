/* Exercise selected recording actions with real IndexedDB and isolated HTTP fixtures. */
'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..'),
  out = process.env.SYNAP_LIBRARY_OUTPUT || '/tmp/synap-library-qa';

const server = createStaticServer(root);
async function seed(page) {
  await page.evaluate(async () => {
    const journal = new DKAudioStore(),
      createdAt = new Date().toISOString(),
      blob = DKAudioCodec.wav([new Int16Array(16000).buffer]);
    const pending = (id) => ({
      id,
      name: 'Batch ' + id.slice(-1),
      createdAt,
      blob,
      durationMs: 1000,
      sizeBytes: blob.size,
      sealed: true,
      status: 'complete',
      notes: 'Preserved note',
    });
    const ready = (id) => ({
      ...pending(id),
      name: id,
      processingStage: 'ready',
      processedAt: createdAt,
      summary: 'Saved summary',
    });
    await journal.atomic(['recordings'], (stores) => {
      for (let i = 0; i < 7; i++) stores.recordings.put(pending('batch-' + i));
      stores.recordings.put({
        ...pending('summary-only'),
        name: 'Summary only',
        transcript: 'Keep the full transcript',
        transcriptComplete: true,
      });
      stores.recordings.put({
        ...pending('unselected'),
        name: 'Unselected pending',
        createdAt: new Date(Date.now() - 86400000).toISOString(),
      });
      stores.recordings.put({ ...ready('ready'), transcript: 'Saved transcript' });
      stores.recordings.put({ ...ready('cloud-ready'), transcript: '', restoredFromCloud: true });
      stores.recordings.put({ ...ready('no-speech'), transcript: '', transcriptComplete: true });
      stores.recordings.put({
        ...pending('partial'),
        name: 'Partial transcript',
        transcript: 'Only part',
        transcriptComplete: false,
        processingStage: 'failed',
        processingRetryable: true,
      });
      stores.recordings.put({
        ...pending('uploading'),
        name: 'Paused upload',
        processingStage: 'uploading',
      });
    });
    await journal.enqueueLegacy('unselected');
    SynapCloudHistory.refreshUiInPlace({ source: 'library-fixture' });
  });
  await page.waitForFunction(() => document.querySelector('#recordingsCount').textContent === '14');
}
async function waitDb(page, check) {
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(check)) return;
    await page.waitForTimeout(75);
  }
  assert.fail('recording storage did not reach the expected state');
}
async function count(page, key) {
  return page.locator('#libraryStatusFilter option[value="' + key + '"]').textContent();
}
async function selectSearch(page, query, status = 'all') {
  await page.locator('#libraryStatusFilter').selectOption(status);
  await page.locator('#librarySearch').fill(query);
  if ((await page.locator('#selectRecordingsButton').getAttribute('aria-pressed')) === 'false')
    await page.locator('#selectRecordingsButton').click();
  await page.locator('#selectAllRecordings').check();
}
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port,
    calls = [];
  const browser = await launchChromium();
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.hostname !== 'fixture.test') return route.abort();
      if (request.method() === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
        });
      const body = request.postData() || '',
        id =
          url.pathname === '/transcribe'
            ? body.match(/name="recording_id"\r\n\r\n([^\r]+)/)?.[1]
            : JSON.parse(body).recording_id;
      calls.push({ path: url.pathname, id });
      const fail = id === 'batch-6' && url.pathname === '/transcribe';
      return route.fulfill({
        status: fail ? 400 : 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(
          fail
            ? { error: 'Fixture rejection' }
            : { transcript: 'Full transcript ' + id, summary: 'Completed summary ' + id },
        ),
      });
    });
    await context.addInitScript(() => {
      localStorage.setItem('synap-ai-provider-settings', JSON.stringify({ provider: 'custom' }));
      localStorage.setItem(
        'dk-pendant-settings',
        JSON.stringify({
          endpoint: 'https://fixture.test/transcribe',
          llmEndpoint: 'https://fixture.test/summary',
          autoProcess: false,
        }),
      );
    });
    const page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(
      () =>
        document.body.dataset.startup === 'ready' &&
        window.SynapLibraryTools &&
        window.SynapMemoryReadyEvents,
    );
    await seed(page);
    await page.locator('.brain-tabs a[href="#library"]').click();
    assert.equal(await count(page, 'transcript'), 'Needs transcript (10)');
    assert.equal(await count(page, 'summary'), 'Needs summary (11)');
    assert.equal(await count(page, 'retry'), 'Needs retry (1)');
    assert.equal(await count(page, 'ready'), 'Ready (3)');
    await page.locator('[data-library-scope="day"]').click();
    assert.equal(
      await count(page, 'transcript'),
      'Needs transcript (9)',
      'date and status filters combine',
    );
    await page.locator('[data-library-scope="all"]').click();
    await selectSearch(page, 'Batch', 'transcript');
    assert.equal(await page.locator('#librarySelectedCount').innerText(), '7 selected');
    assert.equal(
      await page.locator('#recordingsList > .recording-card:visible').count(),
      5,
      'five cards visible, seven selected',
    );
    const card = page.locator('#recordingsList > .recording-card:visible').first();
    await card.locator('.recording-select-input').uncheck();
    assert.equal(
      await card.evaluate((node) => node.open),
      false,
      'checkbox must not open the recording',
    );
    assert.equal(
      await page.locator('#selectAllRecordings').evaluate((node) => node.indeterminate),
      true,
    );
    await page.locator('#showMoreRecordingsButton').click();
    assert.equal(await page.locator('#recordingsList > .recording-card:visible').count(), 7);
    await page.locator('#selectAllRecordings').check();
    // A search change must never leave hidden recordings selected for deletion.
    await page.locator('#librarySearch').fill('Batch 0');
    await page.waitForFunction(
      () => document.querySelector('#librarySelectedCount').textContent === '1 selected',
    );
    await page.locator('#librarySearch').fill('Batch');
    await page.locator('#selectAllRecordings').check();
    for (const [width, mode] of [
      [320, 'light'],
      [390, 'dark'],
      [1440, 'light'],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('#settingsButton').click();
      await page.locator('#settingsTab-appearance').click();
      await page.locator('[data-theme-choice="' + mode + '"]').click();
      await page.locator('#settingsButton').click();
      await page.locator('.brain-tabs a[href="#library"]').click();
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'library fits ' + width,
      );
      await page.screenshot({ path: path.join(out, `library-${mode}-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator('#processSelectedRecordings').click();
    await page.waitForFunction(() =>
      document.querySelector('#libraryActionStatus').textContent.includes('7 recordings queued'),
    );
    await waitDb(page, async () => {
      const records = await new DKAudioStore().all('recordings'),
        jobs = await new DKAudioStore().all('jobs');
      return (
        records.filter((r) => r.id.startsWith('batch-') && r.processingState === 'done').length ===
          6 && jobs.some((j) => j.recordingId === 'batch-6' && j.state === 'failed')
      );
    });
    assert(
      calls.every((call) => call.id?.startsWith('batch-')),
      'only selected recordings reach processing endpoints',
    );
    assert.equal(
      new Set(calls.map((call) => call.id)).size,
      7,
      'selection includes records beyond the first page',
    );
    await page.waitForFunction(
      () =>
        document.querySelector('#libraryStatusFilter option[value="retry"]').textContent ===
        'Needs retry (1)',
    );
    await page.locator('#libraryStatusFilter').selectOption('retry');
    assert.equal(await page.locator('#recordingsList > .recording-card:visible').count(), 1);
    await selectSearch(page, 'Summary only', 'summary');
    await page.locator('#processSelectedRecordings').click();
    await waitDb(
      page,
      async () =>
        (await new DKAudioStore().get('recordings', 'summary-only')).processingState === 'done',
    );
    assert.equal(
      calls.filter((call) => call.id === 'summary-only' && call.path === '/transcribe').length,
      0,
      'existing full transcript is reused',
    );
    assert.equal(
      await page.evaluate(
        async () => (await new DKAudioStore().get('recordings', 'summary-only')).transcript,
      ),
      'Keep the full transcript',
    );
    assert(
      await page.evaluate(async () =>
        (await new DKAudioStore().all('jobs', 'recording', 'unselected')).every(
          (job) => job.state === 'pending',
        ),
      ),
    );
    console.log(
      'PASS library: combined filters, selection across pages, scoped processing, failure filter and transcript reuse',
    );

    await selectSearch(page, 'Batch');
    await page.locator('#deleteSelectedRecordings').click();
    assert.equal(await page.locator('#deleteRecordingsTitle').innerText(), 'Delete 7 recordings?');
    assert.equal(await page.locator('#deleteRecordingsCloud').isChecked(), false);
    assert(await page.locator('#deleteRecordingsCloud').isDisabled());
    await page.locator('#cancelDeleteRecordings').click();
    assert.equal(
      await page.evaluate(
        async () =>
          (await new DKAudioStore().all('recordings')).filter((r) => r.id.startsWith('batch-'))
            .length,
      ),
      7,
    );
    // Simulate one real storage failure; successful items and their jobs are removed,
    // the failed item remains selected, and Retry must target only that item.
    await page.evaluate(async () => {
      window.removeCalls = [];
      window.removeOriginal = DKAudioStore.prototype.remove;
      DKAudioStore.prototype.remove = async function (id) {
        removeCalls.push(id);
        if (id === 'batch-3' && !window.allowRemove) throw new Error('Fixture storage failure');
        return removeOriginal.call(this, id);
      };
      await new DKAudioStore().atomic(['packets'], (s) =>
        s.packets.put({
          recordingId: 'batch-0',
          sequence: 0,
          chunk: 0,
          segmentIndex: 0,
          payload: new Uint8Array(4),
        }),
      );
    });
    await page.locator('#deleteSelectedRecordings').click();
    assert(
      await page.locator('#deleteRecordingsDialog').evaluate((node) => {
        const r = node.getBoundingClientRect();
        return (
          r.x >= 0 &&
          r.y >= 0 &&
          r.right <= innerWidth &&
          r.bottom <= innerHeight &&
          r.height < innerHeight - 80 &&
          node.scrollWidth <= node.clientWidth
        );
      }),
      'deletion dialog and its controls must fit the mobile viewport',
    );
    await page.screenshot({ path: path.join(out, 'delete-confirmation-390.png') });
    await page.locator('#confirmDeleteRecordings').click();
    await page.waitForFunction(
      () =>
        document.querySelector('#confirmDeleteRecordings').textContent === 'Retry 1' &&
        !document.querySelector('#confirmDeleteRecordings').disabled,
    );
    assert.match(
      await page.locator('#deleteRecordingsStatus').innerText(),
      /6 recordings deleted.*1 failed/,
    );
    await page.waitForFunction(
      () => document.querySelector('#librarySelectedCount').textContent === '1 selected',
    );
    await page.evaluate(() => {
      window.allowRemove = true;
    });
    await page.locator('#confirmDeleteRecordings').click();
    await page.waitForFunction(() => !document.querySelector('#deleteRecordingsDialog').open);
    const deletion = await page.evaluate(async () => {
      const journal = new DKAudioStore(),
        result = { calls: removeCalls };
      for (const name of ['recordings', 'jobs', 'segments', 'packets'])
        result[name] = (await journal.all(name)).filter((row) =>
          String(name === 'recordings' ? row.id : row.recordingId).startsWith('batch-'),
        ).length;
      return result;
    });
    assert.deepEqual(
      [deletion.recordings, deletion.jobs, deletion.segments, deletion.packets],
      [0, 0, 0, 0],
    );
    assert.equal(deletion.calls.filter((id) => id === 'batch-3').length, 2);
    assert.equal(
      deletion.calls.filter((id) => id !== 'batch-3').length,
      6,
      'Retry does not repeat successful deletions',
    );
    assert(
      await page.evaluate(
        async () =>
          (await new DKAudioStore().get('recordings', 'unselected')).notes === 'Preserved note',
      ),
    );
    console.log(
      'PASS library: cancellation, local batch deletion, partial storage failure, retry and dependent data cleanup',
    );

    // Only a checked cloud option issues remote deletes. A failed cloud delete
    // must keep the local audio so the user can retry safely.
    await page.evaluate(() => {
      window.cloudCalls = [];
      window.cloudFailure = true;
      SynapAuth.isSignedIn = () => true;
      SynapAuth.session = () => ({ profile: { uid: 'library-fixture' } });
      SynapAuth.config = () => ({ backendUrl: 'https://cloud.fixture.test' });
      SynapAuth.authedFetch = async (url, options = {}) => {
        cloudCalls.push({ url, method: options.method || 'GET' });
        const response = (body, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        if (options.method === 'DELETE')
          return cloudFailure
            ? response({ error: { message: 'Fixture cloud outage' } }, 503)
            : response({ deleted: true });
        if (url.endsWith('/retry')) return response({ already_processing: true });
        if (url.endsWith('/processing')) return response({ state: 'ready', progress: 1 });
        if (url.endsWith('/memory'))
          return response({
            executive_summary: 'Recovered cloud summary',
            transcript: 'Recovered cloud transcript',
            conversations: [],
          });
        if (url.endsWith('/source'))
          return response({
            recording_id: 'cloud-retry',
            state: 'ready',
            executive_summary: 'Recovered cloud summary',
            transcript: 'Recovered cloud transcript',
            transcript_complete: true,
          });
        return response({ recordings: [], people: [], follow_ups: [], merges: [] });
      };
    });
    await selectSearch(page, 'cloud-ready');
    await page.locator('#deleteSelectedRecordings').click();
    assert.equal(await page.locator('#deleteRecordingsCloud').isChecked(), false);
    await page.locator('#deleteRecordingsCloud').check();
    await page.locator('#confirmDeleteRecordings').click();
    await page.waitForFunction(
      () =>
        document.querySelector('#confirmDeleteRecordings').textContent === 'Retry 1' &&
        !document.querySelector('#confirmDeleteRecordings').disabled,
    );
    assert(
      await page.evaluate(async () =>
        Boolean(await new DKAudioStore().get('recordings', 'cloud-ready')),
      ),
    );
    await page.evaluate(() => {
      cloudFailure = false;
    });
    await page.locator('#confirmDeleteRecordings').click();
    await page.waitForFunction(() => !document.querySelector('#deleteRecordingsDialog').open);
    assert.equal(
      await page.evaluate(async () =>
        Boolean(await new DKAudioStore().get('recordings', 'cloud-ready')),
      ),
      false,
    );
    assert.deepEqual(
      await page.evaluate(() => cloudCalls.filter((c) => c.method === 'DELETE').map((c) => c.url)),
      ['/v1/recordings/cloud-ready', '/v1/recordings/cloud-ready'],
    );
    // Restored cloud failures have no local segments: monitor their existing
    // cloud work without inventing a second upload or finalization.
    await page.evaluate(async () => {
      localStorage.setItem('synap-ai-provider-settings', JSON.stringify({ provider: 'synap' }));
      await new DKAudioStore().atomic(['recordings'], (s) =>
        s.recordings.put({
          id: 'cloud-retry',
          name: 'Cloud retry',
          createdAt: new Date().toISOString(),
          sealed: true,
          status: 'complete',
          restoredFromCloud: true,
          processingStage: 'failed',
          processingRetryable: true,
        }),
      );
      SynapCloudHistory.refreshUiInPlace({ source: 'library-fixture' });
    });
    await selectSearch(page, 'Cloud retry', 'retry');
    await page.locator('#processSelectedRecordings').click();
    await waitDb(
      page,
      async () =>
        (await new DKAudioStore().get('recordings', 'cloud-retry')).processingState === 'done',
    );
    const cloud = await page.evaluate(async () => ({
      calls: cloudCalls.filter((c) => c.url.includes('/cloud-retry/')),
      jobs: await new DKAudioStore().all('jobs', 'recording', 'cloud-retry'),
    }));
    assert(cloud.calls.some((c) => c.url.endsWith('/retry')));
    assert(cloud.calls.some((c) => c.url.endsWith('/memory')));
    assert(
      !cloud.calls.some((c) => /\/(segments|finalize|highlights)/.test(c.url)),
      'cloud-only retry does not reupload or finalize',
    );
    assert.equal(cloud.jobs.length, 1);
    assert.equal(cloud.jobs[0].cloudOnly, true);
    assert.equal(cloud.jobs[0].state, 'done');
    assert.deepEqual(errors, [], 'no uncaught page errors');
    console.log(
      'PASS library: optional cloud removal, cloud failure preserves local audio, restored cloud retry and responsive layouts',
    );
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
}
run().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
