'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const server = createStaticServer(path.resolve(__dirname, '..'));
async function until(page, predicate, arg) {
  const deadline = Date.now() + 20000;
  while (!(await page.evaluate(predicate, arg))) {
    if (Date.now() > deadline) throw Error('Asynchronous browser condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port,
    browser = await launchChromium();
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({
          viewport: { width, height: 900 },
          serviceWorkers: 'block',
        }),
        associations = new Map(),
        descriptions = [];
      await context.route('**/*', (r) =>
        new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
      );
      await context.route('**/v1/**', async (route) => {
        const req = route.request(),
          url = new URL(req.url()),
          owner = req.headers().authorization;
        let result = {};
        if (url.pathname === '/v1/devices') result = { devices: associations.get(owner) || [] };
        else if (url.pathname === '/v1/devices/chakshu') {
          const device = req.postDataJSON();
          associations.set(owner, [device]);
          result = { device };
        } else if (url.pathname === '/v1/chakshu/describe') {
          const body = req.postDataJSON();
          assert(body.frames.length <= 5);
          assert(!body.audio && !body.video);
          descriptions.push({ owner, body });
          result = {
            description: 'A white rectangle is visible.',
            frameTimesMs: body.frames.map((f) => f.atMs),
          };
        } else if (url.pathname === '/v1/recordings')
          result =
            req.method() === 'GET'
              ? { recordings: [] }
              : { recording_id: req.postDataJSON().recording_id };
        else result = { people: [], follow_ups: [], state: 'ready', progress: 100, recordings: [] };
        await route.fulfill({
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Headers':
              'Authorization, Content-Type, X-Synap-Client, X-Synap-Schema',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          },
          contentType: 'application/json',
          body: JSON.stringify(result),
        });
      });
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      await context.addInitScript(() => {
        localStorage.setItem(
          'synap-backend-config-v1',
          JSON.stringify({ backendUrl: location.origin, clientId: 'fixture' }),
        );
        localStorage.setItem(
          'synap-auth-session-v1',
          JSON.stringify({
            accessToken: 'owner-a',
            refreshToken: 'owner-a-refresh',
            expiresAt: Date.now() + 3600000,
            profile: { uid: 'owner-a', name: 'A', email: 'a@example.test' },
          }),
        );
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(20000);
      await page.goto(origin + '/?chakshu-media');
      await page.waitForFunction(() => document.body.dataset.startup === 'ready');
      assert.equal(await page.locator('#visualAccess').textContent(), 'Unavailable');
      await page.locator('#headerPendantStatus').click();
      await page
        .waitForFunction(() => SynapChakshu.state.available && SynapChakshu.state.cameraReady)
        .catch(async (e) => {
          console.log(
            await page.evaluate(() => ({
              state: SynapChakshu.state,
              device: SynapDevices.connection?.deviceId,
              module: SynapModules.client?.module,
              auth: SynapAuth.session()?.profile,
              log: document.querySelector('#diagnosticsLog')?.textContent,
            })),
          );
          throw e;
        });
      await page.locator('nav a[href="#library"]').click();
      await page.locator('#visualMode').selectOption('image');
      await page.locator('#visualPhoto').click();
      await page.waitForFunction(() => document.getElementById('visualDialog').open);
      assert.equal(await page.locator('#visualPreview').evaluate((el) => el.naturalWidth), 160);
      await page.locator('#visualDescribe').click();
      await page.waitForFunction(() =>
        document.querySelector('#visualDescriptions').textContent.includes('rectangle'),
      );
      assert.equal(descriptions[0].body.frames.length, 1);
      await page.locator('#visualClose').click();
      await page.locator('#visualPhotoAudio').click();
      await page.waitForFunction(() => document.getElementById('visualDialog').open);
      assert.equal(await page.evaluate(() => SynapAppControls.recordingState().active), true);
      await page.locator('#visualClose').click();
      await page.evaluate(() =>
        SynapAppControls.stopCapture(SynapAppControls.recordingState().sessionId),
      );
      await page.locator('#visualMode').selectOption('video');
      await page.locator('#visualOnline').click();
      await until(page, async () => {
        const s = SynapChakshu.state;
        return s.session?.id && (await SynapChakshu.store.get(s.session.id)).frameCount >= 3;
      });
      const video = await page.evaluate(() => SynapChakshu.state.session.id);
      await until(
        page,
        async (id) => (await SynapChakshu.store.get(id)).descriptions.length > 0,
        video,
      );
      await page.waitForFunction(
        () =>
          document.querySelector('#visualLiveDescription').textContent.includes('rectangle') &&
          document.querySelector('#visualLiveFrame').naturalWidth === 160,
      );
      await page.locator('#visualStop').click();
      await page.waitForFunction(() => !SynapChakshu.state.session);
      const saved = await page.evaluate((id) => SynapChakshu.store.get(id), video);
      assert.equal(saved.kind, 'video');
      assert(saved.audioId);
      assert.equal(saved.state, 'saved');
      const audio = await page.evaluate(
        async (id) => new DKAudioStore().get('recordings', id),
        saved.audioId,
      );
      assert.equal(audio.ownerUid, 'owner-a');
      assert.notEqual(saved.id, audio.id);
      await page.evaluate(
        ({ id, audioId }) => {
          dispatchEvent(
            new CustomEvent('synap-audio-transcribed', {
              detail: {
                ownerUid: 'owner-a',
                recordingId: audioId,
                segmentIndex: 0,
                words: [{ text: 'explain', start_ms: 1800 }],
              },
            }),
          );
        },
        { id: video, audioId: saved.audioId },
      );
      await until(
        page,
        async (id) => (await SynapChakshu.store.get(id)).voiceRequests?.length === 1,
        video,
      );
      assert(descriptions.at(-1).body.frames.length <= 5);
      await page.locator('#visualOffline').click();
      await page.waitForFunction(() => SynapChakshu.state.offline);
      await page.locator('#visualStop').click();
      await page.waitForFunction(() => !SynapChakshu.state.offline);
      await page.locator('#visualSD').click();
      await page.locator('#visualSDList button').first().click();
      await until(page, async () => (await SynapChakshu.store.list()).length >= 4);
      // Import a paired SD take with real image bytes and an independent PCM WAV.
      const jpeg = Buffer.from(
        await page.evaluate(
          async (id) => [
            ...new Uint8Array(await (await SynapChakshu.store.firstFrame(id)).blob.arrayBuffer()),
          ],
          video,
        ),
      );
      const wav = Buffer.alloc(44 + 32000);
      wav.write('RIFF');
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(32000, 40);
      await page.locator('#visualFiles').setInputFiles([
        {
          name: 'paired.mjpeg',
          mimeType: 'video/x-motion-jpeg',
          buffer: Buffer.concat([jpeg, jpeg]),
        },
        { name: 'paired.wav', mimeType: 'audio/wav', buffer: wav },
        {
          name: 'paired.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ frameTimesMs: [0, 500], durationMs: 1000 })),
        },
      ]);
      await until(page, async () =>
        (await SynapChakshu.store.list()).some(
          (r) =>
            r.name === 'paired.mjpeg' && r.state === 'saved' && r.audioId && !r.timingEstimated,
        ),
      );
      // A second account on the same browser cannot see the first account's library.
      await page.evaluate(async () => {
        await SynapAppControls.toggleConnection();
        localStorage.setItem(
          'synap-auth-session-v1',
          JSON.stringify({
            accessToken: 'owner-b',
            refreshToken: 'b',
            expiresAt: Date.now() + 3600000,
            profile: { uid: 'owner-b' },
          }),
        );
        await SynapChakshu.sync();
      });
      assert.equal(await page.locator('#visualAccess').textContent(), 'Unavailable');
      assert.equal(await page.locator('.visual-card').count(), 0);
      await page.evaluate(async () => {
        localStorage.setItem(
          'synap-auth-session-v1',
          JSON.stringify({
            accessToken: 'owner-a',
            refreshToken: 'a',
            expiresAt: Date.now() + 3600000,
            profile: { uid: 'owner-a' },
          }),
        );
        await SynapChakshu.sync();
      });
      await page.waitForFunction(() => document.querySelectorAll('.visual-card').length >= 3);
      fs.mkdirSync('artifacts/workflows/chakshu-library', { recursive: true });
      await page.locator('#visualLibrary').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: 'artifacts/workflows/chakshu-library/library-' + width + '.png',
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
      assert.equal(
        await page.locator('#visualLibrary').evaluate((el) => getComputedStyle(el).color),
        await page.locator('body').evaluate((el) => getComputedStyle(el).color),
      );
      await page.screenshot({
        path: 'artifacts/workflows/chakshu-library/library-dark-' + width + '.png',
      });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log(
      'PASS account gating/isolation, camera transfer, photo descriptions, separate live audio/video, spoken frame window, SD import and layouts',
    );
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  server.close();
  process.exitCode = 1;
});
