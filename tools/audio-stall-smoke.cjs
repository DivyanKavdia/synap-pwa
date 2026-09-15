/* Real recorder and journal: lost callbacks and stalled Stop without a healthy idle reply. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(path.resolve(__dirname, '..'));
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port,
    browser = await launchChromium();
  try {
    for (const mode of ['repair', 'no-audio', 'pendant-stop', 'stop-disconnect', 'stalled-repair']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page.goto(origin + '/?buffered&background&chakshu');
      await page.waitForFunction(() => document.body.dataset.startup === 'ready');
      await page.locator('#headerPendantStatus').click();
      await page.waitForFunction(() => document.body.dataset.state === 'idle' && bleFixture.armed);
      if (mode === 'no-audio' || mode === 'stalled-repair')
        await page.evaluate(() => bleFixture.blockAudio(true));
      if (mode === 'stalled-repair') await page.evaluate(() => {
        window.SynapDisconnectProtection = {
          ...SynapDisconnectProtection,
          replay: () => new Promise(resolve => { window.finishStalledReplay = resolve; }),
        };
      });
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => document.body.dataset.state === 'recording');
      if (mode !== 'no-audio' && mode !== 'stalled-repair')
        await page.waitForFunction(() => SynapAppControls.recordingState().receivedMs >= 500);
      if (mode === 'repair') {
        await page.evaluate(() => bleFixture.loseNotifications());
        await page.waitForFunction(
          () => bleFixture.replayCommands === 1 && bleFixture.pendingFrames === 0,
        );
        assert.equal(await page.evaluate(() => bleFixture.audioSubscriptions), 2);
        assert.equal(await page.evaluate(() => bleFixture.starts), 1);
        await page.locator('#headerCaptureToggle').click();
        await page.waitForFunction(() => document.body.dataset.state === 'idle');
      } else {
        await page.evaluate(() => bleFixture.holdReplay(true));
        if (mode === 'stalled-repair') {
          await page.waitForFunction(() => typeof window.finishStalledReplay === 'function');
          await page.waitForFunction(() => document.body.dataset.state === 'stopping');
        }
        const stoppedAt = Date.now();
        if (mode === 'pendant-stop') await page.evaluate(() => bleFixture.pendantStop());
        else if (mode !== 'stalled-repair') await page.locator('#headerCaptureToggle').click();
        await page.waitForFunction(() => document.body.dataset.state === 'stopping');
        assert.equal(await page.locator('.header-status-text').textContent(), 'Finishing');
        if (mode === 'stop-disconnect') {
          await page.evaluate(() => {
            localStorage.setItem('dk-pendant-auto-reconnect', 'on');
            bleFixture.disconnect();
          });
          await page.waitForFunction(() => document.body.dataset.recordingInterrupted === 'true');
        }
        await page.waitForFunction(
          () =>
            ['idle', 'disconnected'].includes(document.body.dataset.state) &&
            document.body.dataset.recordingInterrupted !== 'true',
        );
        assert(Date.now() - stoppedAt < 13000, 'no-progress Stop is bounded across reconnects');
        if (mode === 'pendant-stop')
          assert.equal(
            await page.evaluate(() => bleFixture.stopWrites),
            0,
            'acknowledged pendant Stop is not rewritten',
          );
        if (mode === 'stalled-repair') {
          await page.evaluate(() => window.finishStalledReplay(false));
          assert.equal(await page.evaluate(() => SynapAppControls.recordingState().active), false);
        }
      }
      const saved = await page.evaluate(async () => ({
        records: await new DKAudioStore().all('recordings'),
        starts: bleFixture.starts,
      }));
      assert.equal(saved.starts, 1);
      assert.equal(saved.records.length, 1, 'one original journal');
      assert.equal(saved.records[0].stopReason, mode === 'repair' ? 'normal' : 'stop-unconfirmed');
      if (mode === 'no-audio' || mode === 'stalled-repair') assert.equal(saved.records[0].stats.completeFrames, 0);
      else assert(saved.records[0].stats.completeFrames >= 10);
      if (mode === 'repair')
        assert.equal(saved.records[0].stats.missingFrames, 0, 'buffered outage was recovered');
      assert.deepEqual(errors, []);
      console.log('PASS audio stall/' + mode);
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
