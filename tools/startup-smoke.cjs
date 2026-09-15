/* Full PWA setup with a slow native bridge: independent setup consumers, then
   immediate capture and reconnect. The fixture rejects concurrent ATT calls. */
'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(path.resolve(__dirname, '..'));
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, browser = await launchChromium();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript(require('./support/pendant-fixture.cjs'));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(30000);
    await page.goto(origin + '/?chakshu&chakshu-media&buffered&ota&slow-startup');
    await page.waitForFunction(() => document.body.dataset.startup === 'ready');
    await page.locator('#headerPendantStatus').click();
    await page.waitForFunction(() => document.body.dataset.state === 'idle' && bleFixture.armed);
    // Firmware discovery cannot precede the core handshake or its idle grace period.
    await page.waitForFunction(() => bleFixture.discoveries.some(row => row.id.startsWith('4fa12349')));
    await page.waitForFunction(() => SynapModules.client?.available && !SynapModules.client.pending &&
      SynapEventChannel.mode === 'event' && !bleFixture.discoveryBusy);
    const startup = await page.evaluate(() => ({
      disconnects: bleFixture.appDisconnects,
      log: document.querySelector('#diagnosticsLog').textContent,
      discoveries: bleFixture.discoveries,
    }));
    assert.equal(startup.disconnects, 0, startup.log);
    assert(!startup.log.includes('GATT timeout:'), startup.log);
    assert(startup.log.includes('Bluetooth operation timing'), 'native and queue timing retained in diagnostics');
    const moduleAt = startup.discoveries.find(row => row.id.startsWith('4fa12350')).at;
    const updaterAt = startup.discoveries.find(row => row.id.startsWith('4fa12348')).at;
    assert(updaterAt - moduleAt >= 4500, 'automatic updater waits for core startup');

    // A user may start while optional discovery is already inside the bridge.
    await page.evaluate(() => {
      bleFixture.delayNextDiscovery('4d', 5000);
      const connection = SynapDevices.connection;
      window.delayedOptional = connection.queue(() => connection.service.getCharacteristic(
        '4fa1234d-0000-1000-8000-00805f9b34fb'), 'Find pendant diagnostics').catch(() => {});
    });
    await page.waitForFunction(() => bleFixture.discoveryBusy);
    await page.locator('#headerCaptureToggle').click();
    await page.waitForFunction(() => document.body.dataset.state === 'recording' &&
      SynapAppControls.recordingState().receivedMs >= 500);
    await page.locator('#headerCaptureToggle').click();
    await page.waitForFunction(() => document.body.dataset.state === 'idle');
    assert.equal(await page.evaluate(() => bleFixture.appDisconnects), 0);

    // Reconnect setup owns a fresh queue and can start another recording.
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(() => bleFixture.disconnect());
      await page.waitForFunction(() => document.body.dataset.state === 'disconnected');
      await page.locator('#headerPendantStatus').click();
      await page.waitForFunction(() => document.body.dataset.state === 'idle');
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => document.body.dataset.state === 'recording' &&
        SynapAppControls.recordingState().receivedMs >= 500);
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(() => document.body.dataset.state === 'idle');
    }
    assert.equal(await page.evaluate(() => bleFixture.appDisconnects), 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS slow startup, deferred updater, Start during discovery and three reconnect/capture cycles');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
