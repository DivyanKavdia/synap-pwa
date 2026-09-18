'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(process.env.SYNAP_UI_ROOT || path.resolve(__dirname, '..'));

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    {
      const context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/?native-link-reject&inventory&ota');
      try {
        await page.waitForFunction(() => document.querySelector('#reconnectStatus')?.textContent.includes('tap Reselect pendant'));
      } catch (error) {
        console.error('Native-link reselection did not settle', await page.evaluate(() => ({
          startup: document.body.dataset.startup,
          state: document.body.dataset.state,
          reconnect: document.querySelector('#reconnectStatus')?.textContent,
          connects: bleFixture.connects,
          appDisconnects: bleFixture.appDisconnects,
          diagnostics: document.querySelector('#diagnosticsLog')?.textContent,
        })));
        throw error;
      }
      assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('qa-connects'))), 2);
      assert.equal(await page.evaluate(() => bleFixture.appDisconnects), 0, 'settled native rejection does not need another disconnect');
      await page.evaluate(() => { bleFixture.hide(); bleFixture.show(); });
      await page.waitForTimeout(3200);
      assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('qa-connects'))), 2, 'foreground cannot restart the unusable-handle loop');
      assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('qa-pickers'))), 0, 'automatic recovery never opens a chooser');
      await page.locator('#headerPendantStatus').click();
      await page.waitForFunction(() => document.body.dataset.state === 'idle');
      assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('qa-pickers'))), 1, 'one real tap reselects with user activation');
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => document.body.dataset.state === 'recording' && bleFixture.captured >= 12);
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => document.body.dataset.state === 'idle');
      const recordings = await page.evaluate(() => new DKAudioStore().all('recordings'));
      assert.equal(recordings.length, 1);
      assert(recordings[0].stats.completeFrames >= 12);
      assert.deepEqual(errors, []);
      console.log('PASS native link rejection: bounded restore, foreground guard, user reselection and recording');
      await context.close();
    }
    for (const [name, query, moduleId] of [
      ['older S3 audio-only firmware', 'minimal-pendant', null],
      ['S3 with OTA', 'ota', 1],
      ['C3 with OTA and recovery', 'ota&c3&buffered', 2],
      ['Chakshu with camera and recovery', 'ota&chakshu-media&buffered', 3],
    ]) {
      const context = await browser.newContext();
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(15000);
      await page.goto(origin + '/?inventory&' + query);
      await page.waitForFunction(() =>
        document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'),
      );
      await page.locator('#headerPendantStatus').click();
      await page.waitForFunction(
        () => document.body.dataset.state === 'idle' && SynapModules.client?.available,
      );
      assert.equal(await page.evaluate(() => SynapModules.client.module?.id ?? null), moduleId);
      await page.waitForTimeout(5500); // Let automatic firmware/diagnostic checks run too.
      assert.equal(await page.evaluate(() => document.body.dataset.state), 'idle');
      assert.equal(await page.evaluate(() => bleFixture.inventoryReads), 1);
      assert.equal(await page.evaluate(() => bleFixture.missingProbes), 0);
      assert.equal(await page.evaluate(() => bleFixture.appDisconnects), 0);
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(
        () => document.body.dataset.state === 'recording' && bleFixture.captured >= 12,
      );
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => document.body.dataset.state === 'idle');
      const recordings = await page.evaluate(() => new DKAudioStore().all('recordings'));
      assert.equal(recordings.length, 1);
      assert(recordings[0].stats.completeFrames >= 12);
      assert.equal(recordings[0].stats.missingFrames, 0);
      await page.evaluate(() => {
        localStorage.setItem('dk-pendant-auto-reconnect', 'on');
        bleFixture.disconnect();
      });
      await page.waitForFunction(
        () => document.body.dataset.state === 'idle' && bleFixture.inventoryReads === 2,
      );
      if (moduleId === 1) {
        for (const count of [3, 4]) {
          await page.evaluate(() => bleFixture.disconnect());
          await page.waitForFunction(
            (expected) =>
              document.body.dataset.state === 'idle' && bleFixture.inventoryReads === expected,
            count,
          );
        }
        const log = await page.locator('#diagnosticsLog').textContent();
        assert.match(log, /"attempt":2,"delayMs":2600/);
        assert.match(log, /"attempt":3,"delayMs":5200/);
      }
      assert.equal(await page.evaluate(() => bleFixture.missingProbes), 0);
      assert.equal(await page.evaluate(() => bleFixture.maximum), 1);
      assert.deepEqual(errors, []);
      console.log(
        'PASS ' + name + ': connect, optional setup, record, save and fresh discovery on reconnect',
      );
      await context.close();
    }
    for (const failure of ['reject', 'incomplete', 'hang']) {
      const context = await browser.newContext();
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(20000);
      await page.goto(origin + '/?inventory-' + failure + '&ota&buffered');
      await page.waitForFunction(() =>
        document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'),
      );
      await page.evaluate(() => localStorage.setItem('dk-pendant-auto-reconnect', 'on'));
      await page.locator('#headerPendantStatus').click();
      if (failure === 'hang') {
        await page.waitForFunction(() => document.body.dataset.state === 'disconnected');
        assert.match(
          await page.locator('#diagnosticsLog').textContent(),
          /"stage":"optional features"/,
        );
        // This is a fresh user retry after the previous native request was
        // cancelled by link teardown, not a race around an unresolved request.
        await page.locator('#headerPendantStatus').click();
      }
      await page.waitForFunction(
        () => document.body.dataset.state === 'idle' && SynapDevices.connection?.service.audioOnly,
      );
      assert.equal(await page.evaluate(() => bleFixture.inventoryReads), 1);
      assert.equal(
        await page.evaluate(() => bleFixture.appDisconnects),
        failure === 'hang' ? 1 : 0,
      );
      await page.waitForTimeout(5500); // Automatic metadata/OTA checks stay local.
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(
        () => document.body.dataset.state === 'recording' && bleFixture.captured >= 12,
      );
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => document.body.dataset.state === 'idle');
      const recording = await page.evaluate(
        async () => (await new DKAudioStore().all('recordings'))[0],
      );
      assert(recording.stats.completeFrames >= 12);
      assert.equal(recording.stats.missingFrames, 0);
      await page.evaluate(() => bleFixture.disconnect());
      await page.waitForFunction(
        () => document.body.dataset.state === 'idle' && SynapDevices.connection?.service.audioOnly,
      );
      assert.equal(
        await page.evaluate(() => bleFixture.inventoryReads),
        1,
        'reconnect uses fresh core discovery without repeating the failed inventory',
      );
      assert.equal(await page.evaluate(() => bleFixture.missingProbes), 0);
      assert.equal(await page.evaluate(() => bleFixture.maximum), 1);
      assert.deepEqual(errors, []);
      console.log(
        'PASS inventory ' +
          failure +
          ': audio-only fallback, record, save, reconnect and serialized native requests',
      );
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
