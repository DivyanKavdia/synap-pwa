/* Real IndexedDB and mounted-source navigation; fixture data never leaves localhost. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(path.resolve(__dirname, '..'));
const output = path.resolve(__dirname, '../artifacts/workflows/workspace-experience');
async function run() {
  fs.mkdirSync(output, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    for (const [theme, width] of [
      ['light', 390],
      ['dark', 390],
      ['light', 320],
      ['dark', 768],
      ['light', 1440],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 860 },
        reducedMotion: 'reduce',
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.addInitScript((theme) => {
        localStorage.setItem('synap-appearance', theme);
        localStorage.setItem('dk-pendant-settings', JSON.stringify({ autoProcess: false }));
      }, theme);
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(10000);
      await page.goto(origin);
      await page.waitForFunction(
        () => document.body.dataset.startup === 'ready' && globalThis.SynapInteractionSurfaces,
      );
      await page.evaluate(async () => {
        const now = new Date(),
          today = SynapActionState.day(now);
        const earlier = new Date(now);
        earlier.setDate(earlier.getDate() - 1);
        const yesterday = SynapActionState.day(earlier);
        const later = new Date(now);
        later.setDate(later.getDate() + 2);
        const tomorrow = SynapActionState.day(later);
        const records = [
          {
            id: 'experience-launch',
            name: 'Recording today',
            summary:
              'The team agreed to release the pilot to 20 customers. Asha will confirm the support plan before launch.',
            title: 'A smaller launch. A clearer plan.',
            time: now,
            duration: 840000,
            conversation: {
              title: 'Pilot launch with Asha',
              participants: ['Asha', 'You'],
              summary:
                'Start with 20 customers and measure activation before opening the next cohort.',
              decisions: [{ text: 'Launch to 20 customers before expanding.', start_ms: 2000 }],
              action_items: [
                {
                  task: 'Send the revised launch brief to Asha',
                  owner: 'self',
                  due_date: today,
                  start_ms: 3000,
                },
                {
                  task: 'Confirm the support plan',
                  owner: 'Asha',
                  due_date: tomorrow,
                  start_ms: 4000,
                },
              ],
              risks: [{ text: 'Support coverage is still unconfirmed.', start_ms: 5000 }],
              unresolved_questions: [{ text: 'Who owns weekend support?', start_ms: 6000 }],
            },
          },
          {
            id: 'experience-design',
            name: 'Design review',
            summary:
              'We chose a simpler onboarding flow. The team will test the prototype with five new users.',
            title: 'Make the first five minutes count',
            time: now,
            duration: 420000,
            conversation: {
              title: 'Onboarding design review',
              participants: ['Maya', 'You'],
              summary:
                'Keep three setup steps and move optional preferences until after the first recording.',
              decisions: [{ text: 'Reduce onboarding to three essential steps.', start_ms: 1000 }],
              action_items: [
                { task: 'Share the onboarding prototype', owner: 'self', start_ms: 2000 },
              ],
            },
          },
          {
            id: 'experience-older',
            name: 'Customer check-in',
            summary: 'The customer needs a rollout timeline and an owner for migration.',
            title: 'Customer rollout',
            time: earlier,
            duration: 600000,
            conversation: {
              title: 'Customer rollout',
              participants: ['Dev', 'You'],
              summary: 'Agree a migration owner before committing the rollout date.',
              action_items: [
                {
                  task: 'Send the migration timeline',
                  owner: 'self',
                  due_date: yesterday,
                  start_ms: 3000,
                },
                { task: 'Confirm the migration owner', owner: '', start_ms: 5000 },
              ],
            },
          },
        ].map((x) => ({
          id: x.id,
          name: x.name,
          createdAt: x.time.toISOString(),
          durationMs: x.duration,
          status: 'saved',
          sealed: true,
          processingState: 'done',
          blob: DKAudioCodec.wav([new Uint8Array(320000)]),
          notes: 'Original notes stay intact',
          summary: x.summary,
          transcript:
            '[00:02] Asha: Launch to 20 customers.\n[00:03] You: I will send the revised launch brief.',
          meeting: {
            title: x.title,
            executive_summary: x.summary,
            people: x.conversation.participants.map((name) => ({ name })),
            conversations: [{ start_ms: 0, end_ms: 8000, ...x.conversation }],
          },
        }));
        await new DKAudioStore().atomic(['recordings'], (stores) =>
          records.forEach((r) => stores.recordings.put(r)),
        );
        SynapCloudHistory.refreshUiInPlace({ source: 'experience-fixture' });
        await SynapBrainUI.refresh();
        await SynapProductivity.refresh(false);
        await SynapInteractionSurfaces.refresh();
      });
      await page.waitForFunction(
        () => document.querySelectorAll('#actionFocusList .synap-follow-row').length === 3,
      );
      const views = [
        ['today', 'Brief'],
        ['library', 'Memories'],
        ['myActions', 'Actions'],
        ['ask', 'Ask'],
      ];
      for (const [id, label] of views) {
        await page
          .getByRole('navigation', { name: 'Primary' })
          .getByRole('link', { name: label, exact: true })
          .click();
        await page.screenshot({
          path: path.join(output, `${theme}-${width}-${id}.png`),
          fullPage: true,
        });
        assert.equal(await page.locator('.brain-tabs a[aria-current="page"]').count(), 1);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${label} ${width} overflow`,
        );
        const visible = await page
          .locator('main > #memoryWorkspace, main > #library, main > #myActions, main > #ask')
          .evaluateAll((nodes) => nodes.filter((n) => n.getClientRects().length).map((n) => n.id));
        assert.equal(visible.length, 1, `${label} has one destination`);
      }
      await page.locator('.brain-tabs a[href="#library"]').click();
      await page.locator('#recording-experience-launch > summary').click();
      await page.locator('#recording-experience-launch audio').waitFor({ state: 'attached' });
      await page.evaluate(
        () => (window.qaSource = document.querySelector('#recording-experience-launch')),
      );
      await page.locator('.brain-tabs a[href="#today"]').click();
      await page.locator('.brain-tabs a[href="#library"]').click();
      assert(
        await page.evaluate(
          () =>
            qaSource === document.querySelector('#recording-experience-launch') && qaSource.open,
        ),
        'source identity and expanded state survive navigation',
      );
      await page.locator('.brain-tabs a[href="#myActions"]').click();
      await page.locator('#actionOverview [data-period="overdue"]').click();
      assert.match(await page.locator('#followupList').innerText(), /Send the migration timeline/);
      assert.doesNotMatch(
        await page.locator('#followupList').innerText(),
        /Send the revised launch brief/,
      );
      await page.locator('#followupList .synap-follow-done').click();
      await page.waitForFunction(
        () =>
          document.querySelector('#actionOverview [data-period="overdue"] strong').textContent ===
          '0',
      );
      await page.locator('.brain-tabs a[href="#today"]').click();
      assert.doesNotMatch(
        await page.locator('#actionFocusList').innerText(),
        /Send the migration timeline/,
      );
      await page.locator('.brief-signal').first().click();
      await page.waitForFunction(
        () =>
          document.querySelector('#recording-experience-launch')?.open &&
          document.body.dataset.synapView === 'library',
      );
      await page.locator('.brain-tabs a[href="#ask"]').click();
      await page.locator('#askScope').selectOption('day');
      await page.locator('.ask-suggestions button').first().click();
      await page.waitForFunction(() =>
        document.querySelector('#askAnswer')?.textContent.includes('Launch to 20 customers'),
      );
      assert.match(await page.locator('#askAnswer').innerText(), /Local recall/);
      assert(await page.locator('#askRecent button').count());
      await page.locator('#askClear').click();
      assert.equal(await page.locator('#askAnswer').innerText(), '');
      assert.equal(await page.locator('#askRecent button').count(), 0);
      const source = await page.evaluate(async () => {
        const r = await new DKAudioStore().get('recordings', 'experience-launch');
        return { notes: r.notes, blob: r.blob.size, transcript: r.transcript };
      });
      assert.equal(source.notes, 'Original notes stay intact');
      assert(source.blob > 0);
      assert.match(source.transcript, /Asha/);
      assert.deepEqual(errors, []);
      console.log(
        `PASS workspace ${theme}/${width}: four destinations, grounded brief, deadline filters, completion, preserved source, local Ask scope and session clear`,
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
  process.exitCode = 1;
  server.close();
});
