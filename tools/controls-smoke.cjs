/* Real application handlers, storage and OTA protocol; only the pendant and
 * public release responses are simulated. Exercise mobile taps, not DOM clicks. */
'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');

const root = process.env.SYNAP_UI_ROOT || path.resolve(__dirname, '..');

const server = createStaticServer(root);
const releaseBase = 'https://raw.githubusercontent.com/DivyanKavdia/synap-firmware/ota-releases/';
function release(target) {
  const c3 = target.includes('c3'),
    prefix = c3 ? 'targets/' + target + '/' : '';
  const identity = 'SYNAP-FW:' + target + ':1.0.0:1201',
    binary = Buffer.alloc(8192);
  binary[0] = 0xe9;
  binary.writeUInt16LE(c3 ? 5 : 9, 12);
  binary.writeUInt32LE(0xabcd5432, 32);
  binary.write(c3 ? 'SYNAP-ESP32C3-OTA-ID-V3' : 'SYNAP-ESP32S3-OTA-ID-V3', 80);
  binary.write(identity, 128);
  const sha256 = crypto.createHash('sha256').update(binary).digest('hex');
  return {
    binary,
    manifest: {
      schema: 3,
      version: '1.0.0',
      build: 1201,
      target,
      protocol: 3,
      chip: c3 ? 5 : 9,
      flashBytes: 4194304,
      psramBytes: c3 ? 0 : 2097152,
      partition: 'default',
      size: binary.length,
      sha256,
      commit: 'a'.repeat(40),
      identity,
      url: releaseBase + prefix + 'builds/1201-' + sha256 + '.bin',
      channel: 'production',
      provenance: {
        provider: 'github-actions',
        repository: 'DivyanKavdia/synap-firmware',
        workflow: '.github/workflows/firmware.yml',
      },
    },
  };
}
const releases = ['esp32s3-fh4r2-qspi-4m', 'esp32c3-supermini-4m'].map(release);
const catalog = {
  schema: 1,
  build: 1201,
  primary: releases[0].manifest.target,
  channel: 'production',
  targets: Object.fromEntries(
    releases.map(({ manifest: m }, i) => [
      m.target,
      i ? 'targets/' + m.target + '/latest.json' : 'latest.json',
    ]),
  ),
};
const waitReady = (page) => page.waitForFunction(() => document.body.dataset.startup === 'ready');
const waitState = (page, state) =>
  page.waitForFunction((state) => document.body.dataset.state === state, state);

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    async function setup(query = '', fault, seed) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        serviceWorkers: 'block',
      });
      let releaseGate = null,
        releaseWait = null;
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) {
          if (url.pathname === '/__qa_storage__')
            return route.fulfill({
              contentType: 'text/html',
              body: '<!doctype html><title>Storage fixture</title>',
            });
          return route.continue();
        }
        if (url.href.startsWith(releaseBase)) {
          if (url.pathname.endsWith('/latest.json') && releaseWait) await releaseWait;
          const r = releases.find((r) => url.href.startsWith(r.manifest.url));
          if (r) return route.fulfill({ contentType: 'application/octet-stream', body: r.binary });
          if (url.pathname.endsWith('/targets.json')) return route.fulfill({ json: catalog });
          if (url.pathname.endsWith('/latest.json'))
            return route.fulfill({
              json: releases[url.pathname.includes('/targets/') ? 1 : 0].manifest,
            });
        }
        return route.abort();
      });
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      if (fault) await context.addInitScript(fault);
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(12000);
      page.on('pageerror', (error) => errors.push(error.message));
      // Embedded browsers may suppress native confirm. OTA must still be usable.
      await page.addInitScript(() => {
        window.confirm = () => false;
      });
      if (seed) {
        await page.goto(origin + '/__qa_storage__');
        await page.addScriptTag({ path: path.join(root, 'audio-store.js') });
        await page.evaluate(seed);
      }
      await page.goto(origin + query);
      return {
        context,
        page,
        errors,
        holdReleases() {
          releaseWait = new Promise((resolve) => {
            releaseGate = resolve;
          });
        },
        release() {
          releaseWait = null;
          releaseGate?.();
        },
      };
    }

    {
      const t = await setup('/', null, async () => {
          const store = new DKAudioStore(),
            createdAt = new Date().toISOString();
          const pcm = new Uint8Array(3200);
          for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
          await store.atomic(['recordings', 'segments', 'jobs'], (s) => {
            s.recordings.put({
              id: 'qa-old',
              name: 'Existing conversation',
              createdAt,
              journal: true,
              status: 'complete',
              notes: 'Keep my note',
              transcript: 'Keep my transcript',
              summary: 'Keep my summary',
            });
            s.segments.put({
              recordingId: 'qa-old',
              index: 0,
              closed: true,
              compacted: true,
              pcmBlob: new Blob([pcm]),
              frameCount: 2,
              timelineFrameCount: 2,
              packets: 8,
              firstSequence: 0,
              lastSequence: 1,
            });
            for (const kind of ['transcribe', 'summarize', 'consolidate'])
              s.jobs.add({
                recordingId: 'qa-old',
                kind,
                segmentIndex: kind === 'consolidate' ? -1 : 0,
                dedupe: 'qa-old:' + (kind === 'consolidate' ? '' : '0:') + kind,
                state: 'done',
                attempts: 1,
                finishedAt: 123,
              });
          });
          (await store.open()).close();
        }),
        { page } = t;
      await page.waitForFunction(() => document.body.dataset.startup !== 'loading');
      assert.equal(
        await page.evaluate(() => document.body.dataset.startup),
        'ready',
        await page.locator('#startupMessage').textContent(),
      );
      const saved = await page.evaluate(async () => {
        const store = new DKAudioStore(),
          record = await store.get('recordings', 'qa-old');
        return {
          record,
          jobs: await store.all('jobs'),
          audio: Array.from(
            new Uint8Array(await (await store.blob(record)).arrayBuffer()).slice(44),
          ),
          recoveredAgain: await store.recover(),
        };
      });
      assert.equal(saved.record.sealed, true);
      assert.equal(saved.record.notes, 'Keep my note');
      assert.equal(saved.record.transcript, 'Keep my transcript');
      assert.equal(saved.record.summary, 'Keep my summary');
      assert.equal(saved.jobs.length, 3);
      assert(saved.jobs.every((job) => job.state === 'done' && job.finishedAt === 123));
      assert.deepEqual(
        saved.audio,
        Array.from({ length: 3200 }, (_, i) => i % 251),
      );
      assert.equal(saved.recoveredAgain, 0);
      const legacy = await page.evaluate(async () => {
        const store = new DKAudioStore({ name: 'qa-legacy-dedupe' }),
          blob = new Blob([new Uint8Array([1, 2, 3])]);
        await store.atomic(['recordings', 'jobs'], (s) => {
          s.recordings.add({ id: 'legacy', blob, notes: 'Original note' });
          for (const kind of ['transcribe', 'summarize', 'consolidate'])
            s.jobs.add({
              recordingId: 'legacy',
              kind,
              dedupe: 'legacy:legacy:' + kind,
              state: 'done',
            });
        });
        await store.enqueueLegacy('legacy');
        await store.enqueueLegacy('legacy');
        const record = await store.get('recordings', 'legacy');
        return {
          record,
          jobs: await store.all('jobs'),
          audio: Array.from(new Uint8Array(await record.blob.arrayBuffer())),
        };
      });
      assert.equal(legacy.record.notes, 'Original note');
      assert(legacy.record.queuedLegacy);
      assert.equal(legacy.jobs.length, 3);
      assert(legacy.jobs.every((job) => job.state === 'done'));
      assert.deepEqual(legacy.audio, [1, 2, 3]);
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'recording');
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'idle');
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log(
        'PASS populated journal recovery preserves audio, notes, transcripts and completed jobs; recording works',
      );
    }

    {
      const t = await setup(
          '/',
          () => {
            window.qaRejectOldCompaction = true;
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (value, ...args) {
              const request = put.call(this, value, ...args);
              if (
                this.name === 'segments' &&
                value.recordingId === 'qa-blocked' &&
                value.pcmBlob &&
                qaRejectOldCompaction
              )
                request.addEventListener('success', () => this.transaction.abort());
              return request;
            };
          },
          async () => {
            const store = new DKAudioStore();
            await store.atomic(['recordings', 'packets', 'segments', 'jobs'], (s) => {
              for (const id of ['qa-blocked', 'qa-good']) {
                s.recordings.put({
                  id,
                  journal: true,
                  status: 'recording',
                  name: id,
                  notes: 'Preserve ' + id,
                });
                s.segments.put({ recordingId: id, index: 0, closed: false });
                for (let sequence = 0; sequence < 2; sequence++)
                  for (let chunk = 0; chunk < 4; chunk++)
                    s.packets.put({
                      recordingId: id,
                      sequence,
                      chunk,
                      total: 4,
                      segmentIndex: 0,
                      payload: new Uint8Array(400).fill(42),
                    });
                s.jobs.add({
                  recordingId: id,
                  kind: 'consolidate',
                  segmentIndex: -1,
                  dedupe: id + ':consolidate',
                  state: 'running',
                });
              }
            });
            (await store.open()).close();
          },
        ),
        { page } = t;
      await waitReady(page);
      assert.match(
        await page.locator('#startupNotice').textContent(),
        /1 earlier recording needs recovery/,
      );
      const before = await page.evaluate(async () => {
        // Reopen the same durable journal and reproduce its per-recording recovery gate.
        const store = new DKAudioStore();
        await store.recover();
        return {
          bad: await store.get('recordings', 'qa-blocked'),
          good: await store.get('recordings', 'qa-good'),
          packets: (await store.all('packets', 'recording', 'qa-blocked')).length,
          segment: await store.get('segments', ['qa-blocked', 0]),
          next: (await store.nextRunnable()).job,
        };
      });
      assert(!before.bad.sealed);
      assert(before.good.sealed);
      assert.equal(before.packets, 8);
      assert(!before.segment.pcmBlob, 'an aborted compaction must keep its raw packets');
      assert.equal(
        before.next.recordingId,
        'qa-good',
        'processing excludes only the deferred recording',
      );
      const rollback = await page.evaluate(async () => {
        const store = new DKAudioStore(),
          job = (await store.all('jobs'))[0];
        let name;
        try {
          await store.atomic(['recordings', 'jobs'], (s) => {
            s.recordings.add({ id: 'qa-rolled-back' });
            s.jobs.add(job);
          });
        } catch (error) {
          name = error.name;
        }
        return { name, row: await store.get('recordings', 'qa-rolled-back') };
      });
      assert.equal(
        rollback.name,
        'ConstraintError',
        'the original request error must reach the caller',
      );
      assert(!rollback.row, 'a rejected transaction has finished rolling back');
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'recording');
      await page.locator('#startupRetry').tap();
      assert.equal(await page.evaluate(() => document.body.dataset.state), 'recording');
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'idle');
      const liveId = await page.evaluate(async () => {
        const store = new DKAudioStore(),
          id = await store.begin('New take outside recovery');
        await store.atomic(['jobs'], (s) =>
          s.jobs.add({
            recordingId: id,
            kind: 'transcribe',
            dedupe: id + ':0:transcribe',
            state: 'running',
          }),
        );
        qaRejectOldCompaction = false;
        return id;
      });
      await page.locator('#startupRetry').tap();
      await page.waitForFunction(() => document.getElementById('startupNotice').hidden);
      const after = await page.evaluate(async (liveId) => {
        const store = new DKAudioStore(),
          record = await store.get('recordings', 'qa-blocked');
        return {
          record,
          packets: (await store.all('packets', 'recording', 'qa-blocked')).length,
          audio: Array.from(
            new Uint8Array(await (await store.blob(record)).arrayBuffer()).slice(44),
          ),
          live: await store.get('recordings', liveId),
          liveJobs: await store.all('jobs', 'recording', liveId),
          jobs: await store.all('jobs', 'recording', 'qa-blocked'),
        };
      }, liveId);
      assert(after.record.sealed);
      assert.equal(after.record.notes, 'Preserve qa-blocked');
      assert.equal(after.packets, 0);
      assert.deepEqual(after.audio, new Array(3200).fill(42));
      assert.equal(after.jobs.length, 3);
      assert(!after.live.sealed);
      assert.equal(
        after.liveJobs[0].state,
        'running',
        'Retry cannot reset another recording’s live work',
      );
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log(
        'PASS aborted recovery preserves raw audio, isolates failed work, permits new recording and retries only historical IDs',
      );
    }

    {
      const t = await setup('/', () => {
          let Store;
          const gate = new Promise((resolve) => {
            window.qaFinishRecovery = resolve;
          });
          Object.defineProperty(window, 'DKAudioStore', {
            configurable: true,
            get: () => Store,
            set(value) {
              Store = value;
              const recover = Store.prototype.recover;
              Store.prototype.recover = async function (...args) {
                window.qaRecoveryWaiting = true;
                await gate;
                return recover.apply(this, args);
              };
            },
          });
        }),
        { page } = t;
      await page.waitForFunction(() => window.qaRecoveryWaiting);
      assert(
        await page.locator('#headerPendantStatus').isEnabled(),
        'Connect remains available while library recovery is pending',
      );
      await page.locator('#settingsButton').tap();
      await page.locator('#headerPendantStatus').tap();
      await waitState(page, 'idle');
      assert(
        await page.locator('#headerCaptureToggle').isDisabled(),
        'recording waits until storage recovery finishes',
      );
      assert.equal(await page.evaluate(() => bleFixture.connects), 1);
      await page.evaluate(() => qaFinishRecovery());
      await waitReady(page);
      await waitState(page, 'idle');
      assert.equal(
        await page.evaluate(() => bleFixture.connects),
        1,
        'finishing startup preserves the existing connection',
      );
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'recording');
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'idle');
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log(
        'PASS Connect works during library recovery; recording waits and the link stays connected',
      );
    }

    {
      const t = await setup('/?lateBluetooth'),
        { page } = t;
      await waitReady(page);
      await waitState(page, 'unsupported');
      assert(
        await page.locator('#headerPendantStatus').isEnabled(),
        'Bluetooth unavailability must not permanently disable Connect',
      );
      await page.locator('#settingsButton').tap();
      await page.locator('#settingsTab-support').tap();
      await page.locator('#settingsButton').tap();
      await page.locator('#headerPendantStatus').tap();
      assert(await page.locator('#settingsDialog').evaluate((node) => node.open));
      assert.match(
        await page.locator('#reconnectStatus').textContent(),
        /Bluetooth access is not available/,
      );
      assert(
        await page.locator('#reconnectStatus').isVisible(),
        'the connection explanation is visible inside Settings',
      );
      await page.locator('#settingsTab-memory').tap();
      await page.locator('#headerPendantStatus').tap();
      assert(
        await page.locator('#reconnectStatus').isVisible(),
        'connection errors return to Device from another open section',
      );
      await page.evaluate(() => bleFixture.enableBluetooth());
      await page.locator('#headerPendantStatus').tap();
      await waitState(page, 'idle');
      assert.equal(
        await page.evaluate(() => bleFixture.pickers),
        1,
        'Connect uses Bluetooth that became available after startup',
      );
      await page.locator('#headerPendantStatus').tap();
      await waitState(page, 'disconnected');
      assert(
        await page.locator('#settingsDialog').evaluate((node) => node.open),
        'Disconnect leaves Settings open',
      );
      await page.locator('#settingsButton').tap();
      await page.evaluate(() => {
        window.qaSyntheticConnects = 0;
        document.addEventListener(
          'click',
          (event) => {
            if (!event.isTrusted && event.target.closest?.('#connectButton')) qaSyntheticConnects++;
          },
          true,
        );
      });
      await page.locator('#headerPendantStatus').tap();
      await waitState(page, 'idle');
      assert.equal(
        await page.evaluate(() => qaSyntheticConnects),
        0,
        'header Connect calls the action without a synthetic tap into a closed dialog',
      );
      assert.equal(
        await page.evaluate(() => bleFixture.starts),
        0,
        'Connect never silently starts recording',
      );
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log(
        'PASS delayed Bluetooth, single header Connect in Settings, Disconnect and visible permission feedback',
      );
    }

    for (const errorName of ['NotFoundError', 'NotAllowedError']) {
      const t = await setup(),
        { page } = t;
      await waitReady(page);
      await page.locator('#settingsButton').tap();
      await page.locator('#settingsTab-appearance').tap();
      await page.evaluate(
        (name) => bleFixture.rejectNextPicker(name, 'Bluetooth permission was denied'),
        errorName,
      );
      await page.locator('#headerPendantStatus').tap();
      await page.waitForFunction(
        () => bleFixture.pickers === 1 && document.body.dataset.state === 'disconnected',
      );
      assert(await page.locator('#reconnectStatus').isVisible());
      assert(await page.locator('#headerPendantStatus').isEnabled());
      await page.locator('#headerPendantStatus').tap();
      await waitState(page, 'idle');
      assert.equal(await page.evaluate(() => bleFixture.pickers), 2);
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log('PASS Connect recovers after ' + errorName + ' without a reload');
    }

    for (const c3 of [false, true]) {
      const t = await setup('/?ota' + (c3 ? '&c3' : '')),
        { page } = t;
      await waitReady(page);
      assert(
        await page.locator('#headerCaptureToggle').isEnabled(),
        'offline microphone offers connect and record',
      );
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'recording');
      assert.equal(
        await page.evaluate(() => bleFixture.starts),
        1,
        'one tap connects and starts exactly once',
      );
      await page.locator('#settingsButton').tap();
      await page.locator('#otaReleaseCheck').tap();
      assert.match(await page.locator('#otaStatus').textContent(), /Stop and save/);
      assert(
        await page.locator('#settingsDialog').evaluate((node) => node.open),
        'blocked check keeps Settings open',
      );
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'idle');
      assert(
        await page.locator('#settingsDialog').evaluate((node) => node.open),
        'header Stop works inside Settings',
      );
      const saved = await page.evaluate(
        async () => (await new DKAudioStore().all('recordings'))[0],
      );
      assert.equal(saved.status, 'saved');
      assert(saved.durationMs > 0, 'Stop persists actual received audio');
      await page.locator('#otaReleaseCheck').tap();
      await page.waitForFunction(() => !document.getElementById('otaLatest').hidden);
      // Starting a fresh background check must not turn a visible Update into a dead control.
      t.holdReleases();
      await page.locator('#otaReleaseCheck').tap();
      await page.waitForFunction(
        () => document.getElementById('otaStatus').textContent === 'Checking…',
      );
      assert(await page.locator('#otaLatest').isEnabled());
      if (c3) {
        await page.locator('#settingsTab-memory').tap();
        await page.locator('#settingsButton').tap();
        await page.locator('#firmwareUpdateButton').tap();
        assert.equal(
          await page.locator('#settingsTab-device').getAttribute('aria-selected'),
          'true',
          'firmware notification opens Device',
        );
      } else await page.locator('#otaLatest').tap();
      await page.waitForFunction(() =>
        document.getElementById('otaStatus').textContent.includes('before installing'),
      );
      await page.evaluate(() => bleFixture.holdFirmware(true));
      t.release();
      await waitState(page, 'updating');
      await page.waitForFunction(() => bleFixture.otaBegins === 1);
      assert(await page.locator('#settingsDialog').evaluate((node) => node.open));
      assert(
        await page.locator('#headerCaptureToggle').isDisabled(),
        'recording locked during actual flash',
      );
      assert(await page.locator('#otaProgress').isVisible());
      await page.locator('#settingsButton').tap();
      assert(
        await page.locator('#firmwareNoticeProgress').isVisible(),
        'main page shows the same running transfer',
      );
      assert(
        await page.locator('#firmwareUpdateButton').isHidden(),
        'no duplicate update action during transfer',
      );
      await page.evaluate(() => bleFixture.holdFirmware(false));
      await page.waitForFunction(
        () =>
          document.getElementById('firmwareNoticeText').textContent === 'Update complete · 1201',
      );
      await waitState(page, 'idle');
      assert.deepEqual(
        await page.evaluate(() => [
          bleFixture.otaBegins,
          bleFixture.otaCommits,
          bleFixture.otaOffset,
          bleFixture.firmwareBuild,
        ]),
        [1, 1, 8192, 1201],
      );
      assert.equal(
        await page.evaluate(() => bleFixture.maximum),
        1,
        'no overlapping GATT operations',
      );
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'recording');
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'idle');
      assert.equal(
        await page.evaluate(async () => (await new DKAudioStore().all('recordings')).length),
        2,
        'recording works after verified reboot',
      );
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log(
        'PASS full app mobile controls / ' +
          (c3 ? 'C3' : 'S3') +
          ': connect-record, Settings Stop, busy check, verified OTA, progress, reboot, record again',
      );
    }

    {
      const t = await setup('/?buffered'),
        { page } = t;
      await waitReady(page);
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'recording');
      await page.waitForFunction(() => bleFixture.captured >= 8);
      await page.evaluate(() => {
        bleFixture.hide();
        bleFixture.disconnect();
      });
      await waitState(page, 'disconnected');
      assert.equal(
        await page.locator('#headerCaptureToggle').getAttribute('aria-label'),
        'Save received recording',
      );
      await page.locator('#headerCaptureToggle').tap();
      await page.waitForFunction(
        () =>
          document.body.dataset.state === 'disconnected' &&
          document.body.dataset.recordingInterrupted === 'false',
      );
      assert.equal(
        await page.evaluate(async () => (await new DKAudioStore().all('recordings'))[0].status),
        'saved',
      );
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log('PASS interrupted recording can be saved from the visible header');
    }

    {
      const t = await setup('/?ota', () => {
          const open = IDBFactory.prototype.open;
          window.qaStorageUnavailable = true;
          IDBFactory.prototype.open = function (...args) {
            if (args[0] === 'dk-pendant-recordings' && qaStorageUnavailable)
              throw new DOMException('Temporary storage failure', 'UnknownError');
            return open.apply(this, args);
          };
        }),
        { page } = t;
      await page.waitForFunction(() => document.body.dataset.startup === 'error');
      assert.match(await page.locator('#startupNotice').textContent(), /Temporary storage failure/);
      assert(await page.locator('#headerCaptureToggle').isDisabled());
      await page.locator('#settingsButton').tap();
      assert(await page.locator('#settingsDialog').evaluate((node) => node.open));
      await page.locator('#headerPendantStatus').tap();
      await waitState(page, 'idle');
      await page.evaluate(() => bleFixture.delayStatusRead());
      await page.waitForFunction(() => bleFixture.readPending);
      await page.locator('#chooseDeviceButton').tap();
      await page.waitForFunction(() => bleFixture.pickers === 2);
      assert.equal(
        await page.evaluate(() => bleFixture.connects),
        1,
        'the chooser opens immediately but the new connection waits for the old native request',
      );
      await page.evaluate(() => bleFixture.finishRead());
      try {
        await page.waitForFunction(
          () => bleFixture.pickers === 2 && document.body.dataset.state === 'idle',
        );
      } catch (error) {
        console.error(
          'Change pendant failed',
          await page.evaluate(() => ({
            pickers: bleFixture.pickers,
            connects: bleFixture.connects,
            state: document.body.dataset.state,
            maximum: bleFixture.maximum,
            diagnostics: document.getElementById('diagnosticsLog').textContent,
          })),
        );
        throw error;
      }
      await page.locator('#settingsButton').tap();
      await page.locator('#otaReleaseCheck').tap();
      await page.waitForFunction(() => !document.getElementById('otaLatest').hidden);
      await page.locator('#otaLatest').tap();
      await page.waitForFunction(
        () => document.getElementById('otaStatus').textContent === 'Update complete · 1201',
      );
      await waitState(page, 'idle');
      assert.equal(
        await page.evaluate(() => document.body.dataset.startup),
        'error',
        'OTA does not pretend failed storage is writable',
      );
      assert.equal(
        await page.evaluate(() => bleFixture.maximum),
        1,
        'Change and OTA keep native Bluetooth operations serialized',
      );
      assert.equal(await page.evaluate(() => bleFixture.starts), 0);
      assert(await page.locator('#headerCaptureToggle').isDisabled());
      await page.locator('#closeSettingsButton').tap();
      await page.evaluate(() => {
        qaStorageUnavailable = false;
      });
      await page.locator('#startupRetry').tap();
      await waitReady(page);
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'recording');
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'idle');
      assert.equal(await page.evaluate(() => bleFixture.starts), 1, 'retry binds record only once');
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log(
        'PASS Change pendant and firmware install work with storage unavailable; Retry restores safe recording',
      );
    }

    {
      const t = await setup('/', () => {
          window.qaRejectWrites = true;
          const add = IDBObjectStore.prototype.add;
          IDBObjectStore.prototype.add = function (...args) {
            const request = add.apply(this, args);
            if (this.name === 'packets' && qaRejectWrites)
              request.addEventListener('success', () => this.transaction.abort());
            return request;
          };
        }),
        { page } = t;
      await page.waitForFunction(() => document.body.dataset.startup === 'error');
      assert.match(
        await page.locator('#startupMessage').textContent(),
        /Storage transaction aborted|AbortError/,
      );
      assert(
        await page.locator('#headerCaptureToggle').isDisabled(),
        'successful reads alone cannot enable recording',
      );
      assert.deepEqual(
        await page.evaluate(async () => {
          const store = new DKAudioStore();
          return Promise.all(
            ['recordings', 'packets', 'segments', 'jobs'].map(
              async (name) => (await store.all(name)).length,
            ),
          );
        }),
        [0, 0, 0, 0],
      );
      await page.evaluate(() => {
        qaRejectWrites = false;
      });
      await page.locator('#startupRetry').tap();
      await waitReady(page);
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'recording');
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'idle');
      assert.equal(await page.evaluate(() => bleFixture.starts), 1);
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log(
        'PASS storage write check prevents unsafe capture, leaves no test rows and recovers without clearing data',
      );
    }

    {
      const t = await setup('/', () =>
          Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }),
        ),
        { page } = t;
      await waitReady(page);
      await page.reload();
      await waitReady(page);
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'recording');
      await page.locator('#headerCaptureToggle').tap();
      await waitState(page, 'idle');
      assert.deepEqual(t.errors, []);
      await t.context.close();
      console.log('PASS fallback-lock reload initializes and recording works immediately');
    }

    {
      const t = await setup(),
        other = await t.context.newPage();
      await waitReady(t.page);
      await other.goto(origin);
      await other.waitForFunction(() => document.body.dataset.startup === 'error');
      assert.match(await other.locator('#startupNotice').textContent(), /Another pendant tab/);
      await other.locator('#startupRetry').tap();
      await other.waitForFunction(() => document.body.dataset.startup === 'error');
      assert(
        await other.locator('#headerCaptureToggle').isDisabled(),
        'Retry never steals a live page lock',
      );
      await other.locator('#settingsButton').tap();
      await other.locator('#chooseDeviceButton').tap();
      assert.equal(
        await other.evaluate(() => bleFixture.pickers),
        0,
        'Change cannot bypass another page’s connection ownership',
      );
      await other.locator('#closeSettingsButton').tap();
      await t.page.close();
      await other.locator('#startupRetry').tap();
      await waitReady(other);
      await other.locator('#headerCaptureToggle').tap();
      await waitState(other, 'recording');
      await other.locator('#headerCaptureToggle').tap();
      await waitState(other, 'idle');
      await t.context.close();
      console.log(
        'PASS second tab explains lock conflict and safely recovers after the owner closes',
      );
    }
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server.close();
});
