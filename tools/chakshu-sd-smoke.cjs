'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const server = createStaticServer(path.resolve(__dirname, '..'));
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port,
    browser = await launchChromium();
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        serviceWorkers: 'block',
      });
      await context.route('**/*', (r) =>
        new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
      );
      let devices = [];
      await context.route('**/v1/**', async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        let result = { recordings: [], people: [], follow_ups: [], state: 'ready', progress: 100 };
        if (url.pathname === '/v1/devices') result = { devices };
        if (url.pathname === '/v1/devices/chakshu') {
          devices = [req.postDataJSON()];
          result = { device: devices[0] };
        }
        await route.fulfill({
          status: 200,
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
            refreshToken: 'fixture',
            expiresAt: Date.now() + 3600000,
            profile: { uid: 'owner-a', name: 'A', email: 'a@example.test' },
          }),
        );
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(20000);
      await page.goto(origin + '/?chakshu-media&sd-fast&missing-sd');
      await page.waitForFunction(() => document.body.dataset.startup === 'ready');
      await page.locator('#headerPendantStatus').click();
      await page.waitForFunction(
        () =>
          SynapChakshu.state.available &&
          SynapChakshu.state.cameraReady &&
          document.body.dataset.state === 'idle',
      );
      await page.locator('nav a[href="#library"]').click();
      assert(await page.locator('#visualWifi').isDisabled());
      assert.match(await page.locator('#visualStorageHint').textContent(), /Insert an SD card/);
      await page.locator('#visualCheckSD').click();
      await page.waitForFunction(() => SynapChakshu.state.storageReady && !SynapChakshu.busy);
      assert.equal(
        await page.evaluate(() => bleFixture.mediaCommands.filter((op) => op === 14).length),
        1,
      );
      assert.match(await page.locator('#visualStorageHint').textContent(), /SD card ready/);
      await page.locator('#headerPhoto').click();
      await page.waitForFunction(
        () =>
          !SynapChakshu.busy &&
          document
            .getElementById('capturePreviewStatus')
            .textContent.includes('Original photo saved to SD'),
      );
      const photo = await page.evaluate(async () => ({
        rows: await SynapChakshu.store.list(),
        ops: bleFixture.mediaCommands,
      }));
      assert(photo.rows[0].previewOnly);
      assert.equal(photo.rows[0].sourcePath, '/synap/abcdef01-00000001.jpg');
      assert(photo.ops.includes(13) && photo.ops.includes(12));
      assert(!photo.ops.includes(2), 'photo chunks use notifications');
      await page.locator('#capturePreviewClose').click();
      await page.locator('#headerVideo').click();
      await page.waitForFunction(() => SynapChakshu.state.offline && !SynapChakshu.state.working);
      assert.equal(
        await page.evaluate(() => bleFixture.starts),
        0,
        'SD video does not send a competing audio stream',
      );
      assert.match(await page.locator('#capturePreviewStatus').textContent(), /Recording to SD/);
      await page.locator('#capturePreviewStop').click();
      await page.waitForFunction(() => !SynapChakshu.state.offline);
      assert.match(await page.locator('#capturePreviewStatus').textContent(), /saved to SD/);
      await page.locator('#capturePreviewClose').click();
      await page.locator('#visualWifi').click();
      await page.waitForFunction(
        () => SynapChakshu.state.wifi?.active && !SynapChakshu.state.working,
      );
      assert.equal(await page.locator('#visualWifiName').textContent(), 'Chakshu-AB12');
      assert.match(
        await page.locator('#visualWifiOpen').getAttribute('href'),
        /^http:\/\/192\.168\.4\.1\/\?key=/,
      );
      assert(await page.locator('#headerCaptureToggle').isDisabled());
      assert(await page.locator('#visualCheckSD').isDisabled());
      assert(await page.locator('#headerPhoto').isDisabled());
      await page.evaluate(() => SynapAppControls.toggleCapture());
      assert.equal(await page.evaluate(() => bleFixture.starts), 0);
      const log = await page.locator('#diagnosticsLog').textContent();
      assert(
        !log.includes('a'.repeat(32)) && !log.includes('b'.repeat(32)),
        'private network credentials never enter diagnostics',
      );
      fs.mkdirSync('artifacts/workflows/chakshu-sd', { recursive: true });
      await page.locator('#visualWifiDetails').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'artifacts/workflows/chakshu-sd/downloads-' + width + '.png' });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.locator('#visualWifiStop').click();
      await page.waitForFunction(() => !SynapChakshu.state.wifi?.active && !SynapChakshu.busy);
      assert.equal(await page.evaluate(() => bleFixture.wifiRunning), false);
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => bleFixture.captured >= 4);
      await page.evaluate(() =>
        SynapAppControls.stopCapture(SynapAppControls.recordingState().sessionId),
      );
      await page.waitForFunction(() => !SynapAppControls.recordingState().active);
      assert.equal(await page.evaluate(() => bleFixture.maximum), 1);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log(
      'PASS inserted SD, notification photo, retained original, SD video, private Wi-Fi UI and return to audio',
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
