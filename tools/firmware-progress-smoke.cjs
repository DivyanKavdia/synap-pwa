/* Real firmware UI handlers and shell with a controlled updater; never flashes hardware. */
'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..'),
  out = process.env.SYNAP_FIRMWARE_OUTPUT || '/tmp/synap-firmware-progress-qa';
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const firmware = app.slice(
  app.indexOf('  function openDeviceSettings()'),
  app.indexOf('  async function registerServiceWorker()'),
);

const server = createStaticServer(root);
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    for (const [mode, width] of [
      ['light', 320],
      ['dark', 390],
      ['light', 1440],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.addInitScript((mode) => localStorage.setItem('synap-appearance', mode), mode);
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(
        () =>
          window.SynapSettingsPanel &&
          document.querySelector('#headerCaptureToggle') &&
          document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'),
      );
      await page.evaluate((source) => {
        const node = (id) => document.getElementById(id);
        // Bind the production handlers once to fresh controls, retaining real layout and navigation.
        for (const id of ['otaLatest', 'otaCancel', 'otaReleaseCheck', 'firmwareUpdateButton']) {
          const button = node(id);
          button.replaceWith(button.cloneNode(true));
        }
        const qa = (window.otaUiFixture = { flashes: 0, holdCheck: false });
        const gate = (name) =>
          new Promise((resolve, reject) => {
            qa[name] = { resolve, reject };
          });
        let connected = true,
          build = 503;
        const id = 'SYNAP-AABBCCDDEEFF',
          manifest = { build: 1001, identity: 'SYNAP-FW:fixture:1001' };
        class Client {
          constructor(io) {
            this.io = io;
            this.committing = false;
            qa.progress = (value) =>
              io.progress('Updating · ' + Math.floor(value * 100) + '%', value, false);
          }
          async check() {
            if (qa.holdCheck) {
              qa.holdCheck = false;
              await gate('check');
            }
            return { protocol: 3, deviceId: id, build, state: 1, capacity: 2048, maxData: 503 };
          }
          async update() {
            qa.flashes++;
            this.committing = false;
            this.io.progress('Updating · 0%', 0, false);
            await gate('transfer');
            this.committing = true;
            connected = false;
            this.io.progress('Restarting pendant…', 1, true);
          }
          reset() {}
          cancel() {}
        }
        const releases = {
          IDENTITY_UUID: 'identity',
          validateManifest: (value) => value,
          latest: async () => manifest,
          compatible: (m, info) => m.build > info.build,
          download: async (_m, _capacity, _fetcher, signal) => {
            const pending = gate('download');
            signal.addEventListener(
              'abort',
              () => qa.download.reject(Error('Download cancelled')),
              { once: true },
            );
            return pending;
          },
        };
        qa.resetBuild = () => {
          build = 503;
        };
        const context = {
          globalThis: {
            SynapOTA: { Client },
            SynapReleases: releases,
            SynapSettingsPanel: window.SynapSettingsPanel,
          },
          deviceAssociation: { deviceId: id },
          connectionEpoch: 0,
          isGattConnected: () => connected,
          connectInProgress: false,
          recordingConfirmed: false,
          finalizing: false,
          currentRecordingId: null,
          openingCapture: null,
          unsavedAudio: false,
          appState: 'idle',
          deviceStatus: { error: 0 },
          SERVICE_UUID: 'service',
          queueGattOperation: (fn) => fn(),
          gattServer: {
            getPrimaryService: async () => ({
              getCharacteristic: async () => ({
                readValue: async () => new TextEncoder().encode(manifest.identity),
              }),
            }),
          },
          ui: {
            settingsDialog: node('settingsDialog'),
            chooseDeviceButton: node('chooseDeviceButton'),
            runQueueButton: node('runQueueButton'),
            queueStatus: node('queueStatus'),
          },
          openSettings: () =>
            node('settingsDialog').open ? SynapSettingsPanel.close() : SynapSettingsPanel.open(),
          clearReconnectTimer() {},
          friendlyError: (error) => error.message,
          log() {},
          processor: { pause() {} },
          setInterval() {},
          acquireWakeLock: async () => {},
          releaseWakeLock: async () => {},
          delay: async (ms) => {
            if (ms === 1500) await gate('reboot');
          },
          disconnectGatt: () => {
            connected = false;
          },
          recoverRememberedConnection() {},
          connectPendant: async () => {
            await gate('reconnect');
            connected = true;
            build = manifest.build;
          },
        };
        new Function(
          ...Object.keys(context),
          'let firmwareBusy=false,firmwareUpdater,checkFirmwareRelease,firmwareControlsBound=false,appLockHeld=true; const setAppState=()=>document.body.dataset.state=firmwareBusy?"updating":"idle";' +
            source +
            ';bindFirmwareUpdate();',
        )(...Object.values(context));
      }, firmware);
      await page.locator('#settingsButton').click();
      await page.locator('#otaReleaseCheck').click();
      await page.waitForFunction(() =>
        document.querySelector('#otaStatus').textContent.includes('available'),
      );
      await page.evaluate(() => (otaUiFixture.holdCheck = true));
      await page.locator('#otaLatest').click();
      assert(
        await page.locator('#settingsDialog').evaluate((node) => node.open),
        'starting from Settings must not close it',
      );
      assert.equal(await page.locator('#firmwareNoticeText').textContent(), 'Preparing update…');
      assert.equal(
        await page.locator('#firmwareNoticeProgress').getAttribute('value'),
        null,
        'preparation has no invented percentage',
      );
      await page.evaluate(() => otaUiFixture.check.resolve());
      await page.waitForFunction(() => !!otaUiFixture.download);
      assert.equal(await page.locator('#otaStatus').textContent(), 'Downloading update…');
      await page.waitForFunction(
        () => document.querySelector('#headerPendantStatus').textContent === 'Updating',
      );
      await page.locator('#settingsButton').click();
      assert(await page.locator('#firmwareUpdateSpinner').isVisible());
      await page.evaluate(() => otaUiFixture.download.resolve(new Blob(['fixture'])));
      await page.waitForFunction(() => !!otaUiFixture.transfer);
      await page.evaluate(() => otaUiFixture.progress(0.42));
      assert.equal(await page.locator('#firmwareNoticeText').textContent(), 'Updating · 42%');
      assert.equal(
        await page.locator('#firmwareNoticeProgress').evaluate((node) => node.position),
        0.42,
      );
      assert(!(await page.locator('#firmwareUpdateButton').isVisible()));
      await page.screenshot({ path: path.join(out, `firmware-${mode}-${width}.png`) });
      await page.locator('#settingsButton').click();
      assert.equal(await page.locator('#otaStatus').textContent(), 'Updating · 42%');
      assert.equal(await page.locator('#otaProgress').evaluate((node) => node.position), 0.42);
      assert(!(await page.locator('#otaLatest').isVisible()));
      await page.locator('#settingsButton').click();
      await page.evaluate(() => otaUiFixture.transfer.resolve());
      await page.waitForFunction(() => !!otaUiFixture.reboot);
      assert.equal(await page.locator('#firmwareNoticeText').textContent(), 'Restarting pendant…');
      assert(await page.locator('#firmwareUpdateSpinner').isVisible());
      assert.equal(
        await page.locator('#firmwareNoticeProgress').evaluate((node) => node.position),
        1,
      );
      assert(await page.locator('#otaCancel').isDisabled(), 'cannot cancel a committed image');
      await page.evaluate(() => otaUiFixture.reboot.resolve());
      await page.waitForFunction(() => !!otaUiFixture.reconnect);
      assert.equal(
        await page.locator('#firmwareNoticeText').textContent(),
        'Reconnecting to verify update…',
      );
      await page.evaluate(() => otaUiFixture.reconnect.resolve());
      await page.waitForFunction(
        () =>
          document.querySelector('#firmwareNoticeText').textContent === 'Update complete · 1001',
      );
      assert(!(await page.locator('#firmwareNoticeProgress').isVisible()));
      assert(!(await page.locator('#firmwareUpdateSpinner').isVisible()));
      assert(!(await page.locator('#firmwareUpdateButton').isVisible()));
      for (const cancel of [false, true]) {
        await page.evaluate(() => {
          otaUiFixture.resetBuild();
          otaUiFixture.download = null;
        });
        await page.locator('#settingsButton').click();
        await page.locator('#otaReleaseCheck').click();
        await page.waitForFunction(() =>
          document.querySelector('#otaStatus').textContent.includes('available'),
        );
        await page.locator('#otaLatest').click();
        await page.waitForFunction(() => !!otaUiFixture.download);
        if (cancel) await page.locator('#otaCancel').click();
        else await page.evaluate(() => otaUiFixture.download.reject(Error('Download failed')));
        await page.waitForFunction(() => document.body.dataset.state === 'idle');
        assert.equal(
          await page.locator('#otaStatus').textContent(),
          cancel ? 'Download cancelled' : 'Download failed',
        );
        assert.equal(
          await page.evaluate(() => otaUiFixture.flashes),
          1,
          'failed/canceled downloads never start a flash',
        );
        await page.locator('#settingsButton').click();
        assert(!(await page.locator('#firmwareUpdateSpinner').isVisible()));
        assert(!(await page.locator('#firmwareNoticeProgress').isVisible()));
        assert(await page.locator('#firmwareUpdateButton').isEnabled());
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS firmware/${mode}/${width}: Settings start, shared live percentage, navigation, reboot verification, failure and cancellation`,
      );
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}
run().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
