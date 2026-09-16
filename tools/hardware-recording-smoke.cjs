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
    for (const query of ['inventory&ota', 'inventory&ota&buffered', 'inventory&ota&c3&buffered', 'inventory-reject&ota']) {
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
      if (query.includes('buffered')) {
        await page.evaluate(() => {
          const input=document.getElementById('autoReconnectInput');input.checked=true;input.dispatchEvent(new Event('change'));
          window.qaHardwareReady=0;
          addEventListener('synap-gatt-ready',()=>window.qaHardwareReady++);
        });
        // The last take's Stop receipt cannot cancel a new START that has not
        // reached the firmware when the connection drops.
        await page.evaluate(() => bleFixture.interruptNextStart());
        await page.locator('#headerCaptureToggle').click();
        await page.waitForFunction(() => document.body.dataset.recordingInterrupted==='true');
        await page.evaluate(() => {bleFixture.show();bleFixture.wake();});
        await page.waitForFunction(() => document.body.dataset.state==='recording' && SynapAppControls.recordingState().receivedMs>=150);
        await page.evaluate(() => bleFixture.pendantDoubleTap());
        await page.waitForFunction(() => document.body.dataset.state==='idle');
        assert.equal(await page.evaluate(() => (new DKAudioStore()).all('recordings').then(rows=>rows.length)),4);
        console.log('PASS previous Stop cannot cancel an undelivered new Start: '+query);
        let saved=4;
        for (const mode of ['retained','expired']) {
          await page.evaluate(() => bleFixture.pendantDoubleTap());
          await page.waitForFunction(() => SynapAppControls.recordingState().recordingId && SynapAppControls.recordingState().receivedMs >= 250);
          const before=await page.evaluate(() => ({received:SynapAppControls.recordingState().receivedMs/50,starts:Number(sessionStorage.getItem('qa-starts')||0),captured:bleFixture.captured}));
          await page.evaluate(() => {bleFixture.hide();bleFixture.disconnect();});
          await page.waitForFunction(n=>bleFixture.captured>=n+4,before.captured);
          await page.evaluate(() => bleFixture.pendantDoubleTap());
          const captured=await page.evaluate(() => bleFixture.captured);
          if (mode==='expired') await page.evaluate(() => bleFixture.expireBuffer());
          await page.evaluate(() => {bleFixture.show();bleFixture.wake();});
          await page.waitForFunction(starts=>document.body.dataset.state==='idle'||Number(sessionStorage.getItem('qa-starts')||0)>starts,before.starts);
          assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('qa-starts')||0)),before.starts,'physical Stop cannot restart after '+mode+' recovery');
          const rows=await page.evaluate(() => new DKAudioStore().all('recordings'));
          assert.equal(rows.length,++saved);
          const latest=rows.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).at(-1);
          assert.equal(latest.status,'saved');
          assert.equal(latest.stats.completeFrames,mode==='retained'?captured:before.received);
          assert.equal(await page.evaluate(() => bleFixture.captured),captured,'microphone remains stopped');
          assert.equal(await page.evaluate(() => window.qaHardwareReady),saved-3,'recovered idle connection publishes readiness');
          console.log('PASS physical Stop while disconnected: '+query+' · '+mode);
        }
      }
      assert.equal(await page.evaluate(() => bleFixture.maximum), 1);
      assert.equal(await page.evaluate(() => bleFixture.appDisconnects), 0);
      assert.deepEqual(errors, []);
      console.log('PASS physical start/stop, immediate audio, duplicate status, slow storage and next take: ' + query);
      await context.close();
    }
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
