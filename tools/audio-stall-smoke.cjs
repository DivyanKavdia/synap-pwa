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
    for (const mode of ['repair', 'no-audio', 'pendant-stop', 'stop-disconnect', 'stalled-repair', 'slow-fragments', 'slow-delivery', 'slow-discovery', 'drain-progress', 'stop-retry', 'stop-write-reconnect']) {
      if (process.argv.length > 2 && !process.argv.slice(2).includes(mode)) continue;
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
      if (mode === 'slow-delivery') await page.evaluate(() => bleFixture.setAudioSendInterval(400));
      if (mode === 'no-audio' || mode === 'stalled-repair' || mode === 'slow-fragments')
        await page.evaluate(() => bleFixture.blockAudio(true));
      if (mode === 'slow-fragments') await page.evaluate(async () => {
        const connection = SynapDevices.connection;
        window.slowAudio = await connection.queue(() => connection.service.getCharacteristic(
          '4fa12346-0000-1000-8000-00805f9b34fb'), 'Prepare congested audio fixture');
      });
      if (mode === 'stalled-repair') await page.evaluate(() => {
        window.SynapDisconnectProtection = {
          ...SynapDisconnectProtection,
          replay: () => new Promise(resolve => { window.finishStalledReplay = resolve; }),
        };
      });
      if (mode === 'slow-discovery') {
        await page.evaluate(() => {
          bleFixture.delayNextDiscovery('56', 5000);
          const connection = SynapDevices.connection;
          window.slowDiscovery = connection.queue(() => connection.service.getCharacteristic(
            '4fa12356-0000-1000-8000-00805f9b34fb'), 'Find voice control');
          window.slowDiscovery.catch(error => { window.slowDiscoveryError = error.message; });
        });
        await page.waitForFunction(() => bleFixture.discoveryBusy);
      }
      if (mode === 'drain-progress') await page.evaluate(() => bleFixture.holdReplay(true));
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => document.body.dataset.state === 'recording');
      if (!['no-audio', 'stalled-repair', 'slow-fragments', 'drain-progress'].includes(mode))
        await page.waitForFunction(() => SynapAppControls.recordingState().receivedMs >= 500);
      if (mode === 'stop-retry' || mode === 'stop-write-reconnect') {
        await page.evaluate(mode=>{
          localStorage.setItem('dk-pendant-auto-reconnect','on');
          bleFixture.rejectNextStops(mode==='stop-retry'?1:3);
        },mode);
        await page.locator('#headerCaptureToggle').click();
        await page.waitForFunction(() => document.body.dataset.state === 'idle' &&
          !SynapAppControls.recordingState().active);
        assert.equal(await page.evaluate(() => bleFixture.appDisconnects),mode==='stop-retry'?0:1);
        assert.equal(await page.evaluate(() => new DKAudioStore().all('recordings').then(rows=>rows[0].stats.missingFrames)),0);
      } else if (mode === 'slow-discovery') {
        assert.equal(await page.evaluate(() => window.slowDiscoveryError), undefined);
        assert.equal(await page.evaluate(() => bleFixture.appDisconnects), 0);
        await page.waitForFunction(() => SynapAppControls.recordingState().receivedMs >= 1000);
        await page.waitForFunction(() => /^00:0[1-9] audio received$/.test(document.getElementById('audioReceptionStatus').textContent));
        await page.locator('#headerCaptureToggle').click();
        await page.waitForFunction(() => document.body.dataset.state === 'idle');
      } else if (mode === 'drain-progress') {
        await page.waitForFunction(() => bleFixture.pendingFrames >= 50);
        await page.locator('#headerCaptureToggle').click();
        await page.waitForFunction(() => document.body.dataset.state === 'stopping');
        const frozenClock = await page.locator('#timer').textContent();
        assert.match(await page.locator('#audioReceptionStatus').textContent(), /^00:00 audio received/);
        await page.evaluate(() => bleFixture.holdReplay(false));
        await page.waitForFunction(() => document.body.dataset.state === 'stopping' &&
          /^00:0[1-9] audio received · finishing/.test(document.getElementById('audioReceptionStatus').textContent));
        assert.equal(await page.locator('#timer').textContent(), frozenClock);
        await page.waitForFunction(() => document.body.dataset.state === 'idle');
      } else if (mode === 'repair') {
        await page.evaluate(() => bleFixture.loseNotifications());
        await page.waitForFunction(
          () => bleFixture.replayCommands === 1 && bleFixture.pendingFrames === 0,
        );
        assert.equal(await page.evaluate(() => bleFixture.audioSubscriptions), 1);
        assert.equal(await page.evaluate(() => bleFixture.starts), 1);
        await page.locator('#headerCaptureToggle').click();
        await page.waitForFunction(() => document.body.dataset.state === 'idle');
      } else if (mode === 'slow-delivery') {
        await page.waitForFunction(() => document.body.dataset.audioDelivery === 'delayed');
        assert.equal(await page.locator('.header-status-text').textContent(), 'Audio delayed');
        assert.match(await page.locator('#audioReceptionStatus').textContent(), /audio received · delayed$/);
        assert(await page.locator('#markMoment').isDisabled());
        assert.equal(await page.evaluate(() => SynapAppControls.recordingState().canStop), true);
        assert.equal(await page.evaluate(() => bleFixture.appDisconnects), 0);
        await page.evaluate(() => bleFixture.setAudioSendInterval(15));
        await page.waitForFunction(() => bleFixture.pendingFrames === 0 &&
          document.body.dataset.audioDelivery === 'receiving');
        assert.equal(await page.locator('.header-status-text').textContent(), 'Listening');
        assert(await page.locator('#markMoment').isEnabled());
        await page.locator('#headerCaptureToggle').click();
        await page.waitForFunction(() => document.body.dataset.state === 'idle');
      } else if (mode === 'slow-fragments') {
        await page.evaluate(async () => {
          for (let sequence = 0; sequence < 2; sequence++) for (let chunk = 0; chunk < 10; chunk++) {
            const v = new DataView(new ArrayBuffer(168));
            v.setUint8(0, 0xa5);v.setUint8(1, 2);v.setUint16(2, sequence, true);
            v.setUint8(4, chunk);v.setUint8(5, 10);v.setUint16(6, 160, true);
            for (let offset = 8; offset < 168; offset += 2) v.setInt16(offset, 1000 + sequence * 10 + chunk, true);
            window.slowAudio.value = v;
            window.slowAudio.dispatchEvent(new Event('characteristicvaluechanged'));
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        });
        assert.equal(await page.evaluate(() => SynapAppControls.recordingState().receivedMs), 100);
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
          // The UI enters stopping before the native STOP write runs. This
          // scenario interrupts an acknowledged drain; wait for that firmware
          // acknowledgement so a fast runner cannot disconnect before STOP.
          await page.waitForFunction(() => SynapDisconnectProtection.isDraining());
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
      assert.equal(saved.records[0].stopReason, ['repair', 'slow-fragments', 'slow-delivery', 'slow-discovery', 'drain-progress', 'stop-retry', 'stop-write-reconnect'].includes(mode) ? 'normal' : 'stop-unconfirmed');
      if (mode === 'no-audio' || mode === 'stalled-repair') assert.equal(saved.records[0].stats.completeFrames, 0);
      else if (mode === 'slow-fragments') {
        assert.equal(saved.records[0].stats.completeFrames, 2);
        const samples = await page.evaluate(async (id) => {
          const store = new DKAudioStore(), recording = await store.get('recordings', id);
          const wav = new DataView(await (await store.blob(recording)).arrayBuffer());
          return Array.from({length: (wav.byteLength - 44) / 2}, (_, i) => wav.getInt16(44 + i * 2, true));
        }, saved.records[0].id);
        assert.deepEqual(samples, Array.from({length: 1600}, (_, i) => 1000 + Math.floor(i / 80)));
      }
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
