/* Saved WAV -> reload -> exact upload retry, with a 26-second gapped PCM take. */
'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(path.resolve(__dirname, '..'));
setTimeout(() => { console.error('WAV upload test exceeded 120 seconds');process.exit(1); }, 120000).unref();
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = process.env.SYNAP_STORAGE_BROWSER === 'webkit'
    ? await require('playwright').webkit.launch() : await launchChromium();
  try {
    const page = await browser.newPage();
    page.on('console', message => console.log('browser:', message.text()));
    page.on('pageerror', error => console.error(error.stack));
    await page.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    await page.route('**/__upload', r => r.fulfill({ contentType: 'text/html', body:
      '<!doctype html><script src="/audio-store.js"></script><script src="/recording/journal.js"></script><script src="/recording/timeline.js"></script><script src="/processing-queue.js"></script><script src="/synap-backend.js"></script>' }));
    await page.goto(origin + '/__upload');
    const id = await page.evaluate(async () => {
      const store = new DKAudioStore(SynapRecordingJournal.options({ transport: true }));
      const id = await store.begin('Upload read fixture');
      for (let sequence = 0; sequence < 520; sequence++) {
        if (sequence === 333) continue;
        const payload = new Uint8Array(1600);new DataView(payload.buffer).setInt16(0, sequence + 1, true);
        store.append(id, { sequence, chunk: 0, total: 1, payload, transport: 'pcm16' });
        if (sequence % 20 === 19) await store.flush();
      }
      console.log('Packets saved');await store.close(id);console.log('Recording sealed');return id;
    });
    // Reload requires reading the browser's durable Blob, not a retained JS object.
    console.log('Reloading saved recording');await page.reload();
    const result = await page.evaluate(async id => {
      console.log('Preparing saved upload');const store = new DKAudioStore(), uploads = [];
      globalThis.SynapAuth = {
        isSignedIn: () => true, session: () => ({ profile: { uid: 'fixture' } }),
        async authedFetch(path, init) {
          console.log('Request', path);
          if (path.includes('/segments/')) {
            uploads.push(new Uint8Array(init.body));
            return new Response('{}', { status: uploads.length === 1 ? 503 : 200 });
          }
          return new Response('{}');
        },
      };
      const job = { recordingId: id, segmentIndex: 0, kind: 'transcribe' };
      let error;
      try { await DKFIFOProcessor.provider('synap').process({ store }, job, {}); }
      catch (e) { error = { stage: e.audioStage, status: e.status }; }
      await DKFIFOProcessor.provider('synap').process({ store }, job, {});
      const record = await store.get('recordings', id);
      const source = new Uint8Array(await (await store.blob(record)).arrayBuffer());
      for (const bytes of uploads) {
        if (bytes.length !== source.length || bytes.some((b, i) => b !== source[i])) throw Error('Upload changed source');
      }
      await DKAudioCodec.validateWav(new Blob([source]));
      console.log('Checking FileReader fallback');const nativeRead = Blob.prototype.arrayBuffer;
      try {
        Blob.prototype.arrayBuffer = async () => new ArrayBuffer(0);
        const copy = new Uint8Array(await DKAudioCodec.readBlob(new Blob([source])));
        if (copy.length !== source.length || copy.some((b, i) => b !== source[i])) throw Error('FileReader fallback changed source');
        await DKAudioCodec.validateWav(new Blob([source]));
      } finally { Blob.prototype.arrayBuffer = nativeRead; }
      return { error, count: uploads.length, bytes: source.length, duration: record.durationMs, missing: record.stats.missingFrames };
    }, id);
    assert.deepEqual(result, { error: { stage: 'sending upload', status: 503 }, count: 2, bytes: 832044, duration: 26000, missing: 1 });
    console.log('PASS ' + (process.env.SYNAP_STORAGE_BROWSER || 'chromium') + ' persisted gapped WAV, reload and byte-identical upload retry');
  } finally { await browser.close();server.close(); }
})().catch(e => { console.error(e);server.close();process.exitCode = 1; });
