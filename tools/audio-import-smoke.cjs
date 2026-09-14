'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const assert = require('node:assert/strict'),
  path = require('node:path'),
  fs = require('node:fs');
const server = createStaticServer(path.resolve(__dirname, '..'));
function sourceWav() {
  const frames = 625,
    bytes = Buffer.alloc(44 + frames * 1600);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 1600, 40);
  for (let sample = 0; sample < frames * 800; sample++)
    bytes.writeInt16LE(
      sample >= 800 && sample < 1600 ? 0 : (sample % 65536) - 32768,
      44 + sample * 2,
    );
  const metadata = Buffer.from(
    JSON.stringify({
      schema: 1,
      source: 'synap-native-ios',
      id: '12345678-1234-1234-1234-123456789abc',
      name: 'Background iPhone take',
      createdAt: '2026-09-01T12:30:00Z',
      deviceId: 'SYNAP-0123456789AB',
      completeFrames: 624,
      missingFrames: 1,
      pcmFrames: 624,
      adpcmFrames: 0,
      moments: [2, 30],
      ownerUid: 'foreign-owner',
    }),
  );
  const header = Buffer.alloc(8);
  header.write('syap');
  header.writeUInt32LE(metadata.length, 4);
  const result = Buffer.concat([bytes, header, metadata, Buffer.alloc(metadata.length % 2)]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}
async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port,
    browser = await launchChromium();
  const uploads = [],
    errors = [],
    calls = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.hostname !== 'fixture.test') return route.abort();
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': 'application/json',
      };
      calls.push({ path: url.pathname, method: request.method() });
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (url.pathname === '/transcribe') {
        const body = request.postDataBuffer(),
          at = body.indexOf(Buffer.from('RIFF'));
        assert.ok(at >= 0);
        uploads.push(body.subarray(at, at + 8 + body.readUInt32LE(at + 4)));
      }
      return route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          transcript: 'The entire source sequence.',
          summary: 'Source preserved.',
        }),
      });
    });
    await context.addInitScript(() => {
      localStorage.setItem('synap-ai-provider-settings', JSON.stringify({ provider: 'custom' }));
      localStorage.setItem(
        'dk-pendant-settings',
        JSON.stringify({
          autoProcess: false,
          endpoint: 'https://fixture.test/transcribe',
          llmEndpoint: 'https://fixture.test/summary',
        }),
      );
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => document.body.dataset.startup === 'ready');
    await page.evaluate(() => {
      globalThis.SynapAuth = { ...SynapAuth, session: () => ({ profile: { uid: 'local-owner' } }) };
      location.hash = '#library';
    });
    const original = sourceWav();
    const input = page.locator('#importAudioFile');
    await input.setInputFiles({ name: 'native.wav', mimeType: 'audio/wav', buffer: original });
    await page.waitForFunction(() =>
      document.querySelector('#libraryActionStatus').textContent.startsWith('Imported Background'),
    );
    const record = await page.evaluate(async () => {
      const store = new DKAudioStore(),
        r = (await store.all('recordings'))[0];
      const parts = await store.all('segments', 'recording', r.id);
      return {
        id: r.id,
        owner: r.ownerUid,
        source: r.captureSource,
        size: r.blob.size,
        duration: r.durationMs,
        stats: r.stats,
        markers: r.rememberMarkers.map((m) => m.offsetMs),
        jobs: (await store.all('jobs')).length,
        parts: parts.map((p) => p.pcmBlob.size),
        bytes: Array.from(new Uint8Array(await r.blob.arrayBuffer())),
      };
    });
    assert.equal(record.owner, 'local-owner');
    assert.equal(record.source, 'native-ios');
    assert.equal(record.duration, 31250);
    assert.deepEqual(record.parts, [960000, 40000]);
    assert.equal(record.jobs, 0);
    assert.equal(uploads.length, 0);
    assert.deepEqual(record.markers, [2000, 30000]);
    assert.equal(record.stats.missingFrames, 1);
    assert.deepEqual(Buffer.from(record.bytes), original);
    // Re-import is explicit duplication, never replacement of a source, notes or account.
    await input.setInputFiles({ name: 'native.wav', mimeType: 'audio/wav', buffer: original });
    await page.waitForFunction(
      () => document.querySelector('#recordingsCount').textContent === '2',
    );
    const ids = await page.evaluate(async () =>
      (await new DKAudioStore().all('recordings')).map((r) => r.id),
    );
    assert.equal(new Set(ids).size, 2);
    const blocked = await page.evaluate(async () => {
      const store = new DKAudioStore(),
        blob = DKAudioCodec.wav([new Int16Array(800)]);
      let calls = 0;
      try {
        await SynapAudioImport.save(blob, store, () => {
          if (++calls === 2)
            globalThis.SynapAuth = {
              ...SynapAuth,
              session: () => ({ profile: { uid: 'changed' } }),
            };
        });
      } catch (error) {
        return { message: error.message, count: (await store.all('recordings')).length };
      }
    });
    assert.match(blocked.message, /account changed/);
    assert.equal(blocked.count, 2);
    await page.evaluate(() => {
      globalThis.SynapAuth = { ...SynapAuth, session: () => ({ profile: { uid: 'local-owner' } }) };
    });
    await input.setInputFiles({
      name: 'broken.wav',
      mimeType: 'audio/wav',
      buffer: original.subarray(0, 100),
    });
    await page.waitForFunction(
      () => document.querySelector('#libraryActionStatus').dataset.error === 'true',
    );
    assert.equal(
      await page.evaluate(async () => (await new DKAudioStore().all('recordings')).length),
      2,
    );
    await page.evaluate((id) => SynapLibraryTools.processIds([id]), record.id);
    let completed = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      completed = await page.evaluate(async (id) => {
        const jobs = await new DKAudioStore().all('jobs', 'recording', id);
        return jobs.length === 5 && jobs.every((j) => j.state === 'done');
      }, record.id);
      if (completed) break;
      await page.waitForTimeout(75);
    }
    assert.ok(completed, 'Imported source processing must finish all five jobs');
    assert.equal(uploads.length, 2, JSON.stringify(calls));
    const chunks = uploads.sort((a, b) => b.length - a.length).map((wav) => wav.subarray(44));
    assert.deepEqual(Buffer.concat(chunks), original.subarray(44, 1000044));
    const out = process.env.SYNAP_IMPORT_OUTPUT || '/tmp/synap-import-qa';
    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'audio-import.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      'PASS: native WAV import, exact source, bounded uploads, owner switch, repeated import and malformed file',
    );
  } finally {
    await browser.close();
  }
}
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => server.close());
