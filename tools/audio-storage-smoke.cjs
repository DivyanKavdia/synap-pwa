/* Real IndexedDB and production window/sequence code, using generated PCM only. */
'use strict';
const assert = require('node:assert/strict');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(require('node:path').resolve(__dirname, '..'));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.route('**/__storage', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><title>Audio storage fixture</title><script src="/audio-store.js"></script><script src="/rolling-transcription.js"></script><script src="/capture-stability.js"></script><script src="/audio-quality.js"></script>' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/__storage');
    const result = await page.evaluate(async () => {
      function frame(sequence) {
        const payload = new Uint8Array(1600), view = new DataView(payload.buffer);
        for (let at = 0; at < 1600; at += 2) view.setInt16(at, sequence + 1, true);
        return { sequence, chunk: 0, total: 1, payload };
      }
      function append(store, id, from, to) {
        for (let sequence = from; sequence <= to; sequence++) store.append(id, frame(sequence));
      }
      async function settle(store) {
        await store.flush();
        await (store.__synapRollingSeal || Promise.resolve());
        await store.flush();
      }
      const store = new DKAudioStore({ name: 'replayed-frames' });
      const id = await store.begin('Recovered window');
      append(store, id, 0, 97);
      append(store, id, 820, 980);
      await settle(store);
      const before = {
        compacted: Boolean((await store.get('segments', [id, 0]))?.pcmBlob),
        packets: (await store.all('packets', 'segment', [id, 0])).length,
        jobs: (await store.all('jobs')).filter(job => job.segmentIndex === 0).length,
      };
      append(store, id, 98, 599);
      await settle(store);
      const after = {
        compacted: Boolean((await store.get('segments', [id, 0]))?.pcmBlob),
        liveWindow: store.__synapRollingIndex.get(id),
      };
      append(store, id, 600, 819);
      const recovered = await store.close(id);
      const wav = new DataView(await (await store.blob(recovered)).arrayBuffer());
      let exact = wav.byteLength === 44 + 981 * 1600;
      for (let sequence = 0; sequence < 981; sequence++) {
        for (let sample = 0; sample < 800; sample++) {
          if (wav.getInt16(44 + sequence * 1600 + sample * 2, true) !== sequence + 1) exact = false;
        }
      }

      // The same gap without recovered packets stays visible in duration and UI.
      const gaps = new DKAudioStore();
      const gapId = await gaps.begin('Audio gap fixture');
      append(gaps, gapId, 0, 97);
      append(gaps, gapId, 820, 980);
      await settle(gaps);
      const gapRecording = await gaps.close(gapId);
      const gapWav = new DataView(await (await gaps.blob(gapRecording)).arrayBuffer());
      let zeroFrames = 0;
      for (let sequence = 0; sequence < 981; sequence++) {
        let zero = true;
        for (let sample = 0; sample < 800; sample++) {
          if (gapWav.getInt16(44 + sequence * 1600 + sample * 2, true) !== 0) zero = false;
        }
        if (zero) zeroFrames++;
      }

      const emptyWindow = new DKAudioStore({ name: 'entire-missing-window' });
      const emptyId = await emptyWindow.begin('Missing whole window');
      append(emptyWindow, emptyId, 0, 10);
      append(emptyWindow, emptyId, 1200, 1209);
      await settle(emptyWindow);
      await emptyWindow.close(emptyId);
      const uploadWindows = (await emptyWindow.all('jobs')).filter(job => job.kind === 'transcribe').map(job => job.segmentIndex).sort();

      const partial = new DKAudioStore({ name: 'partial-audio-evidence' });
      const partialId = await partial.begin('Partial frame');
      partial.append(partialId, { sequence: 0, chunk: 0, total: 2, payload: new Uint8Array(800).fill(17) });
      const partialRecording = await partial.close(partialId);
      return {
        before, after, recovered: { stats: recovered.stats, durationMs: recovered.durationMs, exact },
        gap: { id: gapId, stats: gapRecording.stats, durationMs: gapRecording.durationMs, zeroFrames,
          notice: SynapAudioQuality.gaps(gapRecording.stats, gapRecording.durationMs) },
        uploadWindows,
        partial: { status: partialRecording.status, packets: (await partial.all('packets')).length, jobs: (await partial.all('jobs')).length },
      };
    });
    assert.deepEqual(result.before, { compacted: false, packets: 98, jobs: 0 });
    assert.deepEqual(result.after, { compacted: true, liveWindow: 1 });
    assert.equal(result.recovered.stats.completeFrames, 981);
    assert.equal(result.recovered.stats.missingFrames, 0);
    assert.equal(result.recovered.durationMs, 49050);
    assert.equal(result.recovered.exact, true, 'every recovered sample retains its original position');
    assert.equal(result.gap.zeroFrames, 722);
    assert.equal(result.gap.stats.missingFrames, 722);
    assert.equal(result.gap.durationMs, 49050);
    assert.equal(result.gap.notice.label, '36.1 s missing (74%)');
    assert.deepEqual(result.uploadWindows, [0, 1, 2], 'silent timeline windows must not strand backend finalization');
    assert.deepEqual(result.partial, { status: 'empty', packets: 1, jobs: 0 });

    await page.goto(origin + '/');
    await page.waitForFunction(() => document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'));
    await page.locator('.brain-tabs a[href="#library"]').click();
    const card = page.locator('#recording-' + result.gap.id);
    await card.waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await card.locator('.recording-row-meta').textContent(), /Audio incomplete: 36\.1 s missing \(74%\)/);
    await card.locator('summary').first().click();
    await card.locator('.recording-audio-gap').waitFor({ state: 'visible' });
    assert.match(await card.locator('.recording-audio-gap').textContent(), /cannot restore missing speech/);
    assert.deepEqual(errors, []);
    console.log('PASS audio integrity: late replay restores exact PCM; missing windows stay visible and uploadable; partial packets remain stored');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
