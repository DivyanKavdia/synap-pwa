'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const server = createStaticServer(path.resolve(__dirname, '..'));
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port,
    browser = await launchChromium();
  try {
    for (const model of [false, true, 'flash']) {
      const context = await browser.newContext({
          viewport: { width: 320, height: 900 },
          serviceWorkers: 'block',
        }),
        associations = new Map(),
        descriptions = [];
      let goodDownload = false,
        downloads = 0;
      await context.route('**/*', (r) =>
        new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
      );
      await context.route('**/models/*/srmodels.bin', (route) => {
        downloads++;
        return route.fulfill({
          status: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: Buffer.alloc(2177224, goodDownload ? 0 : 1),
        });
      });
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

      // Synthetic model bytes exercise the full BLE path without bundling weights in tests.
      // Only the zero-filled fixture maps to the pinned digest; other inputs use real SHA-256.
      await context.addInitScript(() => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        crypto.subtle.digest = async (name, input) => {
          const bytes = new Uint8Array(
            input.buffer || input,
            input.byteOffset || 0,
            input.byteLength,
          );
          if (bytes.length === 2177224 && bytes.every((b) => b === 0))
            return Uint8Array.from(
              '9bb7348b31891a89eb494f5995970a7fc52b765759e4992d471ab2901bf9c47c'.match(/../g),
              (h) => parseInt(h, 16),
            ).buffer;
          return digest(name, input);
        };
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(20000);
      await page.goto(
        origin +
          '/?chakshu-media&voice' +
          (model ? '&model' : '') +
          (model === 'flash' ? '&flash-model' : ''),
      );
      await page.waitForFunction(() => document.body.dataset.startup === 'ready');
      assert(await page.locator('#chakshuVoice').isHidden());
      if (model === 'flash') await page.evaluate(() => bleFixture.setSdAvailable(false));
      await page.locator('#headerPendantStatus').click();
      await page.waitForFunction(
        () => SynapChakshu.state.available && document.body.dataset.state === 'idle',
      );
      await page.locator('#settingsButton').click();
      await page.locator('#chakshuVoice').waitFor({ state: 'visible' });
      if (!model) {
        await page.waitForFunction(() =>
          document
            .getElementById('chakshuModelStatus')
            .textContent.includes('Update Chakshu firmware first'),
        );
        assert(await page.locator('#chakshuModelInstall').isDisabled());
      } else if (model === 'flash') {
        await page.waitForFunction(() =>
          document.getElementById('chakshuModelStatus').textContent.includes('internal flash'),
        );
        for (const id of ['Install', 'Cancel', 'Restart', 'Progress', 'Manual'])
          assert(await page.locator('#chakshuModel' + id).isHidden());
        // Model storage and recognizer status arrive through separate GATT reads.
        await page.waitForFunction(() => !document.getElementById('chakshuVoiceEnabled').disabled);
        await page.locator('#chakshuVoiceEnabled').click();
        await page.waitForFunction(() => SynapChakshuVoice.state?.status === 5);
        await page.locator('#chakshuVoiceEnabled').click();
        await page.waitForFunction(() => SynapChakshuVoice.state?.status === 1);
        await page.evaluate(() => SynapChakshuModel.install());
        assert.equal(downloads, 0);
        assert.equal(await page.evaluate(() => bleFixture.model.begins), 0);
        assert.equal(await page.evaluate(() => SynapChakshuModel.busy), false);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        fs.mkdirSync('artifacts/workflows/chakshu-model', { recursive: true });
        await page.locator('#chakshuVoice').scrollIntoViewIfNeeded();
        await page.screenshot({ path: 'artifacts/workflows/chakshu-model/internal-flash-320.png' });
      } else {
        await page.waitForFunction(() => !document.getElementById('chakshuModelInstall').disabled);
        await page.locator('#chakshuModelInstall').click();
        await page.waitForFunction(() =>
          document
            .getElementById('chakshuModelStatus')
            .textContent.includes('integrity check failed'),
        );
        assert.equal(await page.evaluate(() => bleFixture.model.begins), 0);
        goodDownload = true;
        await page.locator('#chakshuModelInstall').click();
        await page.waitForFunction(() => bleFixture.model.offset >= 480);
        assert(await page.locator('#headerCaptureToggle').isDisabled());
        assert(await page.locator('#headerPhoto').isDisabled());
        assert(await page.locator('#headerVideo').isDisabled());
        assert.equal(await page.evaluate(() => SynapAppControls.canReload()), false);
        await assert.rejects(
          page.evaluate(() => SynapModules.run(2)),
          /model installation/,
        );
        await page.locator('#chakshuModelCancel').click();
        await page.waitForFunction(() => bleFixture.model.state === 4 && !SynapChakshuModel.busy);
        await page.evaluate(() => bleFixture.modelFailAt(48000));
        await page.locator('#chakshuModelInstall').click();
        await page.waitForFunction(
          () => document.body.dataset.state === 'disconnected' && !SynapChakshuModel.busy,
        );
        const paused = await page.evaluate(() => bleFixture.model);
        assert.equal(paused.begins, 2);
        assert.equal(paused.offset, 48000);
        await page.evaluate(() => SynapAppControls.toggleConnection());
        await page.waitForFunction(
          () =>
            document.getElementById('chakshuModelInstall').textContent === 'Resume installation' &&
            !document.getElementById('chakshuModelInstall').disabled,
        );
        await page.locator('#chakshuModelInstall').click();
        await page.waitForFunction(
          () => bleFixture.model.state === 3 && !SynapChakshuModel.busy,
          null,
          { timeout: 120000 },
        );
        assert.equal(await page.evaluate(() => bleFixture.model.begins), 2);
        assert.equal(await page.locator('#chakshuModelProgress').evaluate((e) => e.value), 100);
        fs.mkdirSync('artifacts/workflows/chakshu-model', { recursive: true });
        await page.locator('#chakshuModelRestart').scrollIntoViewIfNeeded();
        await page.screenshot({ path: 'artifacts/workflows/chakshu-model/installed-320.png' });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.locator('#chakshuModelRestart').click();
        await page.waitForFunction(() => bleFixture.model.state === 5);
        assert.equal(await page.evaluate(() => bleFixture.maximum), 1);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log(
      'PASS model installation: old firmware, integrity, cancel, connection resume, capture exclusion, mobile layout, explicit restart',
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
