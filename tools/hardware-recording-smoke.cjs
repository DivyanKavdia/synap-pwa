'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(path.resolve(__dirname, '..'));
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    for (const query of ['inventory&ota', 'inventory&ota&c3&buffered', 'inventory-reject&ota']) {
      const context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page.goto(origin + '/?' + query);
      await page.waitForFunction(() => document.body.dataset.startup === 'ready');
      await page.locator('#headerPendantStatus').click();
      await page.waitForFunction(() => document.body.dataset.state === 'idle');
      await page.evaluate(() => {
        const begin = DKAudioStore.prototype.begin;
        DKAudioStore.prototype.begin = async function(...args) {
          await new Promise(resolve => setTimeout(resolve, 600));
          return begin.apply(this, args);
        };
      });
      for (let take = 1; take <= 2; take++) {
        await page.evaluate(() => { bleFixture.pendantDoubleTap(); bleFixture.notifyStatus(); bleFixture.notifyStatus(); });
        await page.waitForFunction(() => document.body.dataset.state === 'recording' && bleFixture.captured >= 3);
        // Stop while the journal still opens: it must save rather than restart.
        await page.evaluate(() => bleFixture.pendantDoubleTap());
        await page.waitForFunction(() => document.body.dataset.state === 'idle');
        const rows = await page.evaluate(() => new DKAudioStore().all('recordings'));
        assert.equal(rows.length, take, 'one journal per hardware start');
        assert(rows.every(row => row.durationMs >= 150 && row.status === 'saved'));
        assert(rows.every(row => row.stats.missingFrames === 0 && row.stats.incompleteFrames === 0));
        const captured = await page.evaluate(() => bleFixture.captured);
        const latest = rows.sort((a,b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
        assert.equal(latest.stats.completeFrames, captured, 'every early fragment survives delayed storage');
        assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-starts')), null, 'adoption never sends another START');
      }
      // A take started on the phone must also stop from the physical control.
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => document.body.dataset.state === 'recording' && bleFixture.captured >= 3);
      await page.evaluate(() => bleFixture.pendantDoubleTap());
      await page.waitForFunction(() => document.body.dataset.state === 'idle');
      assert.equal(await page.evaluate(() => (new DKAudioStore()).all('recordings').then(rows => rows.length)), 3);
      assert.equal(await page.evaluate(() => bleFixture.maximum), 1);
      assert.equal(await page.evaluate(() => bleFixture.appDisconnects), 0);
      assert.deepEqual(errors, []);
      console.log('PASS physical start/stop, immediate audio, duplicate status, slow storage and next take: ' + query);
      await context.close();
    }
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
