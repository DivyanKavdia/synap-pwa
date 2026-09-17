'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const server = createStaticServer(path.resolve(__dirname, '..'));
async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  const out = process.env.SYNAP_VOICE_OUTPUT || '/tmp/synap-voice-qa';
  fs.mkdirSync(out, { recursive: true });
  try {
    for (const width of [320, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 850 },
        reducedMotion: 'reduce',
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(10000);
      await page.goto(origin);
      await page.waitForFunction(
        () => window.SynapVoiceProfile && document.body.dataset.startup === 'ready',
      );
      await page.evaluate(async () => {
        window.voiceQA = {
          uid: 'owner',
          posts: [],
          profiles: {},
          stops: 0,
          requests: 0,
          holdMic: false,
          quiet: false,
          holdSave: false,
          holdBody: false,
          holdClose: false,
        };
        SynapAuth.isSignedIn = () => true;
        SynapAuth.session = () => ({ profile: { uid: voiceQA.uid, name: 'Diyan Kavdia' } });
        SynapAuth.authedFetch = async (url, options = {}) => {
          if (url !== '/v1/voice-profile') return Response.json({ people: [], follow_ups: [] });
          const qa = voiceQA,
            key = qa.uid;
          if (options.method === 'POST') {
            qa.saveSignal = options.signal;
            qa.expectedUid = options.expectedUid;
            if (qa.holdSave)
              await new Promise((resolve) => {
                qa.releaseSave = resolve;
              });
            if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
            qa.posts.push({
              uid: key,
              name: decodeURIComponent(options.headers['X-Synap-Voice-Name']),
              wav: [...new Uint8Array(options.body).slice(0, 4)],
            });
            qa.profiles[key] = { enrolled: true, displayName: qa.posts.at(-1).name };
          }
          if (options.method === 'PATCH')
            qa.profiles[key].displayName = JSON.parse(options.body).display_name;
          if (options.method === 'DELETE') delete qa.profiles[key];
          if (options.method === 'POST' && qa.holdBody)
            return { ok: true, json: () => new Promise(() => {}) };
          return Response.json({
            available: true,
            supports_display_name: true,
            enrolled: false,
            ...qa.profiles[key],
          });
        };
        const makeStream = () => ({
          getTracks: () => [
            {
              stop: () => {
                voiceQA.stops++;
              },
            },
          ],
        });
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: async () => {
              voiceQA.requests++;
              if (voiceQA.holdMic)
                await new Promise((resolve) => {
                  voiceQA.allowMic = resolve;
                });
              return makeStream();
            },
          },
        });
        window.AudioContext = class {
          sampleRate = 16000;
          destination = {};
          resume() {
            return Promise.resolve();
          }
          close() {
            return voiceQA.holdClose ? new Promise(() => {}) : Promise.resolve();
          }
          createMediaStreamSource() {
            return { connect() {}, disconnect() {} };
          }
          createScriptProcessor() {
            return {
              disconnect() {},
              connect() {
                const samples = new Float32Array(16000 * 6).fill(voiceQA.quiet ? 0 : 0.15);
                this.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
              },
            };
          }
        };
        await SynapVoiceProfile.refresh();
      });
      await page.locator('#settingsButton').click();
      await page.locator('#settingsTab-memory').click();
      await page.locator('#synapVoiceProfileSetup').click();
      await page.locator('#synapVoiceName').fill('Divyan Kavdia');
      assert(await page.locator('#synapVoiceStart').isDisabled(), 'explicit consent is required');
      await page.locator('#synapVoiceConsent').check();
      await page.clock.install();
      await page.locator('#synapVoiceStart').click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#synapVoiceProfileSetup').disabled);
      assert.equal(await page.evaluate(() => voiceQA.posts.length), 0);
      assert.equal(await page.evaluate(() => voiceQA.stops), 1, 'Cancel releases microphone');
      // A permission prompt can finish after the dialog is cancelled.
      await page.evaluate(() => {
        voiceQA.holdMic = true;
      });
      await page.locator('#synapVoiceProfileSetup').click();
      await page.locator('#synapVoiceConsent').check();
      await page.locator('#synapVoiceStart').click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.evaluate(() => voiceQA.allowMic());
      await page.waitForFunction(
        () => voiceQA.stops === 2 && !document.querySelector('#synapVoiceProfileSetup').disabled,
      );
      await page.evaluate(() => {
        voiceQA.holdMic = false;
      });
      await page.locator('#synapVoiceProfileSetup').click();
      await page.locator('#synapVoiceName').fill('Divyan Kavdia');
      await page.locator('#synapVoiceConsent').check();
      await page.screenshot({ path: path.join(out, 'voice-setup-' + width + '.png') });
      assert(
        await page.locator('#synapVoiceName').evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= innerWidth;
        }),
      );
      await page.evaluate(() => {
        voiceQA.holdSave = true;
      });
      await page.locator('#synapVoiceStart').click();
      await page.clock.runFor(10050);
      await page.waitForFunction(() => !!voiceQA.releaseSave);
      assert.equal(await page.locator('#synapVoiceCountdown').innerText(), 'Saving profile');
      assert.equal(
        await page.evaluate(() => voiceQA.stops),
        await page.evaluate(() => voiceQA.requests),
      );
      const requestsBeforeSave = await page.evaluate(() => voiceQA.requests);
      await page.clock.runFor(2000);
      assert.equal(await page.locator('#synapVoiceCountdown').innerText(), 'Saving profile');
      assert.equal(await page.evaluate(() => voiceQA.requests), requestsBeforeSave);
      await page.evaluate(() => {
        voiceQA.holdSave = false;
        voiceQA.releaseSave();
      });
      await page.waitForFunction(() => !document.querySelector('#synapVoiceProfileDialog').open);
      assert.equal(await page.evaluate(() => voiceQA.posts.length), 1);
      assert.equal(await page.evaluate(() => voiceQA.posts[0].name), 'Divyan Kavdia');
      assert.deepEqual(await page.evaluate(() => voiceQA.posts[0].wav), [82, 73, 70, 70]);
      assert.match(await page.locator('#synapVoiceProfileStatus').innerText(), /Divyan Kavdia/);
      await page.locator('#synapVoiceProfileSetup').click();
      await page.locator('#synapVoiceName').fill('Divyan K.');
      await page.locator('#synapVoiceSaveName').click();
      await page.waitForFunction(() => !document.querySelector('#synapVoiceProfileDialog').open);
      assert.equal(
        await page.evaluate(() => voiceQA.posts.length),
        1,
        'editing a name needs no new voice sample',
      );
      assert.match(await page.locator('#synapVoiceProfileStatus').innerText(), /Divyan K\./);
      // Upload/auth can hang despite AbortSignal support in the browser bridge.
      // The UI must show saving rather than a stuck 1s countdown, and recover.
      await page.evaluate(() => {
        voiceQA.holdSave = true;
        voiceQA.holdClose = true;
      });
      await page.locator('#synapVoiceProfileSetup').click();
      await page.locator('#synapVoiceConsent').check();
      await page.locator('#synapVoiceStart').click();
      await page.clock.runFor(10050);
      await page.waitForFunction(() => !!voiceQA.releaseSave);
      const micRequestsAfterRecording = await page.evaluate(() => voiceQA.requests);
      assert.equal(
        await page.evaluate(() => voiceQA.stops),
        micRequestsAfterRecording,
        'all microphone tracks stop before saving starts',
      );
      assert.equal(await page.locator('#synapVoiceCountdown').innerText(), 'Saving profile');
      assert.match(
        await page.locator('#synapVoicePrompt').innerText(),
        /Recording finished.*microphone is off/,
      );
      assert.equal(await page.locator('#synapVoiceProgress').evaluate((node) => node.value), 10);
      await page.clock.runFor(16000);
      assert.equal(
        await page.locator('#synapVoiceCountdown').innerText(),
        'Saving profile',
        'saving never starts a second elapsed recording clock',
      );
      assert.match(
        await page.locator('#synapVoicePrompt').innerText(),
        /microphone is off.*longer than usual/,
      );
      assert.equal(
        await page.evaluate(() => voiceQA.requests),
        micRequestsAfterRecording,
        'waiting for the profile never restarts microphone capture',
      );
      assert(await page.locator('#synapVoiceStart').isDisabled());
      await page.screenshot({ path: path.join(out, 'voice-saving-' + width + '.png') });
      await page.clock.runFor(90000);
      await page.waitForFunction(() => !document.querySelector('#synapVoiceStart').disabled);
      assert.match(await page.locator('#synapVoiceError').innerText(), /did not respond in time/);
      assert.equal(await page.locator('#synapVoiceCountdown').innerText(), 'Save not confirmed');
      assert.equal(
        await page.evaluate(() => voiceQA.requests),
        micRequestsAfterRecording,
        'a failed save requires an explicit recording retry',
      );
      assert.equal(await page.evaluate(() => voiceQA.saveSignal.aborted), true);
      assert.equal(await page.evaluate(() => voiceQA.expectedUid), 'owner');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.evaluate(() => {
        voiceQA.holdSave = false;
        voiceQA.holdClose = false;
        voiceQA.releaseSave();
      });
      assert.equal(
        await page.evaluate(() => voiceQA.posts.length),
        1,
        'expired upload cannot submit late',
      );
      // Even response-body parsing is bounded. The server may already have saved
      // this request, so the UI must not promise the old profile is unchanged.
      await page.evaluate(() => {
        voiceQA.holdBody = true;
      });
      await page.locator('#synapVoiceProfileSetup').click();
      await page.locator('#synapVoiceConsent').check();
      await page.locator('#synapVoiceStart').click();
      await page.clock.runFor(10050);
      await page.waitForFunction(() => voiceQA.posts.length === 2);
      await page.clock.runFor(106000);
      assert.match(await page.locator('#synapVoiceError').innerText(), /did not respond in time/);
      assert.doesNotMatch(await page.locator('#synapVoicePrompt').innerText(), /unchanged/);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.evaluate(() => {
        voiceQA.holdBody = false;
      });
      // An account change cancels capture before any upload under the new identity.
      await page.locator('#synapVoiceProfileSetup').click();
      await page.locator('#synapVoiceConsent').check();
      await page.locator('#synapVoiceStart').click();
      await page.evaluate(async () => {
        voiceQA.uid = 'other';
        await SynapVoiceProfile.refresh();
      });
      await page.clock.runFor(10050);
      assert.equal(await page.evaluate(() => voiceQA.posts.length), 2);
      await page.waitForFunction(() => !document.querySelector('#synapVoiceProfileSetup').disabled);
      assert.doesNotMatch(await page.locator('#synapVoiceProfileStatus').innerText(), /Divyan K\./);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        'PASS voice setup/' +
          width +
          ': confirmed name, consent, cancellation, late permissions, rename and account isolation',
      );
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
