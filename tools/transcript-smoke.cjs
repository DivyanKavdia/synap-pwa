/* Real mobile shell/IndexedDB transcript recovery, with read-only cloud fixtures. */
'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const path = require('node:path');

const root = path.resolve(__dirname, '..');

const server = createStaticServer(root);

async function fixture(page) {
  await page.evaluate(async () => {
    const ids = ['cached', 'missing', 'partial', 'retry'];
    const createdAt = new Date().toISOString();
    window.qa = { calls: [], sourceFailure: 'retry', sources: {}, holdSource: 'missing' };
    const pcm = new Int16Array(16000),
      header = new DataView(new ArrayBuffer(44));
    const ascii = (offset, value) =>
      [...value].forEach((c, i) => header.setUint8(offset + i, c.charCodeAt(0)));
    ascii(0, 'RIFF');
    header.setUint32(4, 36 + pcm.byteLength, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, 16000, true);
    header.setUint32(28, 32000, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    ascii(36, 'data');
    header.setUint32(40, pcm.byteLength, true);
    const journal = new DKAudioStore();
    await journal.atomic(['recordings'], (stores) => {
      for (const id of ids) {
        stores.recordings.put({
          id,
          name: 'Conversation ' + id,
          createdAt,
          sealed: true,
          status: 'complete',
          durationMs: 1000,
          notes: 'Original note',
          blob: new Blob([header.buffer, pcm], { type: 'audio/wav' }),
          ...(id !== 'partial' ? { processedAt: createdAt } : {}),
          transcript: id === 'cached' ? 'Preserved spoken words' : '',
          summary: id === 'partial' ? '' : 'Saved summary ' + id,
          processingStage: id === 'partial' ? 'failed' : 'ready',
          processingRetryable: id === 'partial',
        });
        qa.sources[id] = {
          recording_id: id,
          started_at: createdAt,
          duration_ms: 1000,
          state: id === 'partial' ? 'failed' : 'ready',
          retryable: id === 'partial',
          executive_summary: id === 'partial' ? '' : 'Saved summary ' + id,
          transcript: '[00:00] Alex: Recovered spoken words for ' + id,
          transcript_complete: id !== 'partial',
          transcript_segments: 1,
          segment_count: id === 'partial' ? 2 : 1,
        };
      }
    });
    SynapAuth.isSignedIn = () => true;
    SynapAuth.session = () => ({ profile: { uid: 'transcript-fixture' } });
    SynapAuth.authedFetch = async (url, options = {}) => {
      qa.calls.push({ url, method: options.method || 'GET' });
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
      const source = url.match(/^\/v1\/recordings\/([^/]+)\/source$/);
      if (source) {
        const id = decodeURIComponent(source[1]);
        if (qa.holdSource === id)
          await new Promise((resolve) => {
            qa.releaseSource = resolve;
          });
        if (qa.sourceFailure === id) return reply({ error: { message: 'Temporary outage' } }, 503);
        return reply(qa.sources[id] || {}, qa.sources[id] ? 200 : 404);
      }
      if (/^\/v1\/recordings\?/.test(url)) {
        if (qa.holdHistory)
          await new Promise((resolve) => {
            qa.releaseHistory = resolve;
          });
        return reply({
          recordings: ids.map((id) => {
            const {
              transcript,
              transcript_complete,
              transcript_segments,
              segment_count,
              ...metadata
            } = qa.sources[id];
            return metadata;
          }),
        });
      }
      return reply({ recordings: [], people: [], follow_ups: [], merges: [] });
    };
    SynapCloudHistory.refreshUiInPlace({ source: 'transcript-fixture' });
  });
  await page.waitForFunction(
    () => document.querySelectorAll('#insightsList .insight-card[data-recording-id]').length === 3,
  );
}

async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    for (const [mode, width] of [
      ['light', 320],
      ['dark', 390],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: true,
        reducedMotion: 'reduce',
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.addInitScript((mode) => localStorage.setItem('synap-appearance', mode), mode);
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(
        () =>
          document.body.dataset.startup === 'ready' &&
          window.SynapProvenance &&
          window.SynapExperienceRecovery,
      );
      await fixture(page);

      // Reproduce the real day-list payload: summary metadata, no transcript.
      const preserved = await page.evaluate(async () => {
        await SynapCloudHistory.restoreAndShow(true, {
          day: document.querySelector('#datePicker').value,
          transcript: false,
        });
        const record = await new DKAudioStore().get('recordings', 'cached');
        return { transcript: record.transcript, notes: record.notes, bytes: record.blob.size };
      });
      assert.deepEqual(preserved, {
        transcript: 'Preserved spoken words',
        notes: 'Original note',
        bytes: 32044,
      });

      await page.locator('.brain-tabs a[href="#today"]').tap();
      const memory = page.locator('#insightsList [data-recording-id="missing"].insight-card');
      await memory.locator('summary.insight-top').tap();
      const tab = memory.getByRole('tab', { name: 'Transcript', exact: true });
      assert(await tab.isVisible(), 'Transcript remains reachable before its text is downloaded');
      await tab.tap();
      await page.waitForFunction(() => qa.releaseSource);
      assert.match(
        await memory.locator('.synap-provenance-transcript').innerText(),
        /Loading transcript/,
      );
      await page.evaluate(() => {
        qa.holdSource = '';
        qa.releaseSource();
      });
      await page.waitForFunction(() =>
        document
          .querySelector(
            '#insightsList [data-recording-id="missing"].insight-card .synap-provenance-transcript',
          )
          ?.textContent.includes('Recovered spoken words for missing'),
      );
      assert.equal(
        await tab.getAttribute('aria-selected'),
        'true',
        'hydration keeps the selected Transcript tab',
      );
      assert(await memory.locator('.synap-provenance-transcript').isVisible());
      assert.equal(
        await page.evaluate(
          () => qa.calls.filter((call) => call.url === '/v1/recordings/missing/source').length,
        ),
        1,
        'one shared source read',
      );
      await page.evaluate(async () => {
        await SynapCloudHistory.restoreAndShow(true, {
          day: document.querySelector('#datePicker').value,
          transcript: false,
        });
      });
      assert.match(
        await memory.locator('.synap-provenance-transcript').innerText(),
        /Recovered spoken words for missing/,
      );
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
      if (process.env.SYNAP_TRANSCRIPT_OUTPUT) {
        fs.mkdirSync(process.env.SYNAP_TRANSCRIPT_OUTPUT, { recursive: true });
        await memory.screenshot({
          path: path.join(process.env.SYNAP_TRANSCRIPT_OUTPUT, `memory-${mode}-${width}.png`),
        });
      }

      // An old request must not roll back text/notes saved while it was in flight.
      await page.evaluate(() => {
        qa.holdHistory = true;
        qa.history = SynapCloudHistory.restore(true, { transcript: false });
      });
      await page.waitForFunction(() => qa.releaseHistory);
      await page.evaluate(async () => {
        const journal = new DKAudioStore();
        await journal.atomic(['recordings'], (stores) => {
          const get = stores.recordings.get('cached');
          get.onsuccess = () =>
            stores.recordings.put({
              ...get.result,
              transcript: 'Recovered during refresh',
              notes: 'Edited during refresh',
            });
        });
        qa.holdHistory = false;
        qa.releaseHistory();
        await qa.history;
      });
      const concurrent = await page.evaluate(() => new DKAudioStore().get('recordings', 'cached'));
      assert.equal(concurrent.transcript, 'Recovered during refresh');
      assert.equal(concurrent.notes, 'Edited during refresh');

      await page.locator('.brain-tabs a[href="#library"]').tap();
      const retry = page.locator('#recording-retry');
      await retry.locator(':scope > summary').tap();
      await retry
        .locator('.recording-disclosure > summary')
        .filter({ hasText: /^Transcript/ })
        .tap();
      await retry
        .getByRole('button', { name: 'Retry transcript', exact: true })
        .waitFor({ state: 'visible' });
      assert.match(
        await retry.locator('.synap-transcript-notice').innerText(),
        /Could not load the transcript/,
      );
      await page.evaluate(() => {
        qa.sourceFailure = '';
      });
      await retry.getByRole('button', { name: 'Retry transcript', exact: true }).tap();
      await page.waitForFunction(() =>
        document
          .querySelector('#recording-retry .recording-transcript')
          ?.value.includes('Recovered spoken words for retry'),
      );
      assert(await retry.locator('.recording-transcript').isVisible());

      // A summary failure must not hide sealed transcript windows or claim ready.
      const partial = page.locator('#recording-partial');
      await partial.locator(':scope > summary').tap();
      await partial
        .locator('.recording-disclosure > summary')
        .filter({ hasText: /^Transcript/ })
        .tap();
      await page.waitForFunction(() =>
        document
          .querySelector('#recording-partial .recording-transcript')
          ?.value.includes('Recovered spoken words for partial'),
      );
      assert(await partial.locator('.recording-transcript').isVisible());
      await page.waitForFunction(() =>
        document
          .querySelector('#recording-partial .synap-transcript-notice')
          ?.textContent.includes('available so far'),
      );
      assert.match(
        await partial.locator('.synap-transcript-notice').innerText(),
        /available so far/,
      );
      assert.equal(
        await page.evaluate(
          async () => (await new DKAudioStore().get('recordings', 'partial')).processingStage,
        ),
        'failed',
      );
      await page.evaluate(() => {
        qa.sources.partial.transcript = '';
      });
      await partial.getByRole('button', { name: 'Refresh transcript', exact: true }).tap();
      await page.waitForFunction(
        () =>
          document
            .querySelector('#recording-partial .synap-transcript-notice')
            ?.getAttribute('aria-busy') === 'false',
      );
      assert.match(
        await partial.locator('.recording-transcript').inputValue(),
        /Recovered spoken words for partial/,
        'an empty incomplete response keeps the preserved transcript',
      );
      const calls = await page.evaluate(
        () => qa.calls.filter((call) => call.url.endsWith('/source')).length,
      );
      await page.waitForTimeout(350);
      assert.equal(
        await page.evaluate(() => qa.calls.filter((call) => call.url.endsWith('/source')).length),
        calls,
        'restoring a selected tab does not refetch in a loop',
      );
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'mobile transcript view fits',
      );
      assert.deepEqual(errors, [], 'no uncaught page errors');
      console.log(
        `PASS transcripts/${mode}/${width}: metadata preservation, missing-tab recovery, stable selection, concurrent edits, load retry and partial evidence`,
      );
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server.close();
});
