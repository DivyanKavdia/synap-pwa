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
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
