'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const assert = require('node:assert/strict'),
  path = require('node:path'),
  fs = require('node:fs');
const output = path.resolve('artifacts/workflows/first-memory');
const server = createStaticServer(path.resolve(__dirname, '..'));
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const width of [320, 390, 768, 1440])
      for (const mode of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: mode,
        });
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        await context.addInitScript((mode) => {
          localStorage.setItem('synap-appearance', mode);
          localStorage.setItem(
            'dk-pendant-settings',
            JSON.stringify({ autoProcess: false, wakeLock: false }),
          );
        }, mode);
        const page = await context.newPage(),
          errors = [];
        page.setDefaultTimeout(12000);
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(origin);
        await page.waitForFunction(
          () =>
            document.body.dataset.startup === 'ready' &&
            document.body.dataset.firstMemory === 'true',
        );
        assert(await page.locator('#firstMemory').isVisible());
        const memory = await page.locator('#memoryWorkspace').boundingBox();
        assert(
          memory.height < (width >= 760 ? 420 : 570),
          `welcome leaves room for the workspace at ${width}px: ${memory.height}px`,
        );
        const actions = await page.locator('#myActions').boundingBox();
        assert(actions.y < 720, 'Actions is reachable in the first viewport');
        for (const id of ['firstMemoryRecord', 'firstMemorySample', 'firstMemoryAccount']) {
          const rect = await page.locator('#' + id).boundingBox();
          assert(rect.height >= 44, `${id} keeps a comfortable touch target`);
        }
        assert.equal(
          await page.locator('#firstMemoryAccount').innerText(),
          'Sign in for cloud memories',
        );
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          'first use fits the viewport',
        );
        await page.screenshot({ path: path.join(output, `welcome-${mode}-${width}.png`) });
        await page.locator('#firstMemorySample').click();
        assert(await page.locator('#sampleMemory').isVisible());
        assert(
          (await page.locator('#sampleMemoryDescription').innerText()).includes(
            'Nothing here is saved',
          ),
        );
        await page.screenshot({ path: path.join(output, `sample-${mode}-${width}.png`) });
        await page.locator('[data-sample-source="24"]').click();
        assert.equal(
          await page.locator('#sampleTab-transcript').getAttribute('aria-selected'),
          'true',
        );
        assert.equal(await page.evaluate(() => document.activeElement.id), 'sampleSource-24');
        assert(
          (await page.locator('#sampleSource-24').innerText()).includes('five design partners'),
        );
        assert(await page.locator('#sampleSource-24').isVisible());
        await page.locator('#sampleTab-actions').click();
        await page.locator('#sampleTaskDone').check();
        assert(await page.locator('#sampleTaskDone').isChecked());
        await page.locator('#sampleTab-actions').focus();
        await page.keyboard.press('End');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'sampleTab-transcript');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'firstMemorySample');
        await page.locator('#firstMemorySample').click();
        assert(!(await page.locator('#sampleTaskDone').isChecked()));
        assert(await page.locator('#sampleBack').isVisible());
        await page.locator('#sampleBack').click();
        const count = await page.evaluate(async () => {
          const store = new DKAudioStore();
          return (await store.all('recordings')).length;
        });
        assert.equal(
          count,
          0,
          'exploring/checking off the sample cannot create a personal recording',
        );
        await page.locator('#firstMemoryAccount').click();
        assert.equal(
          await page.locator('#settingsTab-memory').getAttribute('aria-selected'),
          'true',
        );
        assert(await page.locator('#synapAccountFields').isVisible());
        await page.locator('#closeSettingsButton').click();
        await page.evaluate(() => {
          window.realDesktopCapture = SynapDesktopCapture;
          let phase = 'recording';
          window.setHeaderMeetingPhase = (value) => {
            phase = value;
            dispatchEvent(new CustomEvent('synap-desktop-capture-changed'));
          };
          window.headerMeetingStops = 0;
          window.SynapDesktopCapture = {
            supported: () => true,
            state: () => ({
              active: phase !== 'idle',
              phase,
              recordingId: 'header-meeting',
              startedAt: Date.now() - 65000,
            }),
            stop: async () => {
              window.headerMeetingStops++;
              phase = 'idle';
              dispatchEvent(new CustomEvent('synap-desktop-capture-stopped'));
            },
          };
          dispatchEvent(new CustomEvent('synap-desktop-capture-started'));
        });
        assert.equal(
          await page.locator('#headerCaptureToggle').getAttribute('aria-label'),
          'Stop and save meeting',
        );
        assert(await page.locator('#recordingSessionBar').isVisible());
        assert.equal(await page.locator('#timer').innerText(), '01:05');
        await page
          .locator('.topbar')
          .screenshot({ path: path.join(output, `meeting-header-${mode}-${width}.png`) });
        await page.evaluate(() => setHeaderMeetingPhase('saving'));
        assert(await page.locator('#headerCaptureToggle').isDisabled());
        assert.equal(
          await page.locator('#headerCaptureToggle').getAttribute('aria-label'),
          'Saving meeting',
        );
        await page.evaluate(() => setHeaderMeetingPhase('save-failed'));
        assert(!(await page.locator('#headerCaptureToggle').isDisabled()));
        assert.equal(
          await page.locator('#headerCaptureToggle').getAttribute('aria-label'),
          'Retry saving meeting',
        );
        await page.locator('#headerCaptureToggle').click();
        assert.equal(await page.evaluate(() => window.headerMeetingStops), 1);
        await page.evaluate(() => {
          window.SynapDesktopCapture = window.realDesktopCapture;
          dispatchEvent(new CustomEvent('synap-desktop-capture-changed'));
        });
        // Exercise first-save guidance against actual IndexedDB and the app's
        // existing Library rendering; only the explicit cloud action is stubbed.
        await page.evaluate(async () => {
          const store = new DKAudioStore();
          await store.open();
          await store.atomic(['recordings'], (stores) =>
            stores.recordings.put({
              id: 'first-take',
              name: 'First take',
              createdAt: new Date().toISOString(),
              durationMs: 30000,
              status: 'saved',
              sealed: true,
              summary: '',
              transcript: '',
              sampleRate: 16000,
              sizeBytes: 960044,
            }),
          );
          document
            .getElementById('datePicker')
            .dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForFunction(
          () => document.getElementById('firstMemoryRecord').textContent === 'Create memory',
        );
        await page.evaluate(() => {
          SynapLibraryTools.processIds = async (ids) => {
            window.processedFirstIds = ids;
          };
        });
        await page.locator('#firstMemoryRecord').click();
        assert.deepEqual(await page.evaluate(() => window.processedFirstIds), ['first-take']);
        await page.evaluate(async () => {
          const store = new DKAudioStore();
          await store.atomic(['recordings'], (stores) => {
            const request = stores.recordings.get('first-take');
            request.onsuccess = () =>
              stores.recordings.put({
                ...request.result,
                summary: 'A verified first memory.',
                processingStage: 'ready',
              });
          });
          document
            .getElementById('datePicker')
            .dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForFunction(() => document.getElementById('firstMemory').hidden);
        assert(
          await page.locator('#today > .day-brief').isVisible(),
          'real memory replaces first-use guidance',
        );
        assert.deepEqual(errors, []);
        await context.close();
      }
    console.log(
      'First-use, source navigation, accessible sample and first-save workflows passed at 320/390/768/1440 in both themes.',
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
