/* Real shell/IndexedDB journeys with a deterministic cloud API fixture.
 * Run with Playwright installed: node tools/workflow-smoke.cjs
 * No account credentials, real cloud writes or pendant are used.
 */
'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const path = require('node:path');

const root = path.resolve(__dirname, '..');

const server = createStaticServer(root);

async function seed(page) {
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const q = indexedDB.open('dk-pendant-recordings');
      q.onsuccess = () => resolve(q.result);
    });
    const pcm = new Int16Array(16000),
      header = new DataView(new ArrayBuffer(44));
    const ascii = (offset, value) =>
      [...value].forEach((c, i) => header.setUint8(offset + i, c.charCodeAt(0)));
    ascii(0, 'RIFF');
    header.setUint32(4, 36 + pcm.byteLength, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, 16000, true);
    header.setUint32(28, 32000, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    ascii(36, 'data');
    header.setUint32(40, pcm.byteLength, true);
    await new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', 'readwrite');
      for (let i = 0; i < 6; i++) {
        const name = ['Alex', 'Blair', 'Casey', 'Dev', 'Eli', 'Fern'][i];
        const createdAt = new Date(Date.now() - i * 60000).toISOString();
        tx.objectStore('recordings').put({
          id: 'journey-' + i,
          name: 'Prototype ' + i,
          createdAt,
          ownerUid: 'journey-user',
          status: 'complete',
          sealed: true,
          durationMs: 1000,
          sampleRate: 16000,
          sizeBytes: 32044,
          processingStage: 'ready',
          blob: new Blob([header.buffer, pcm], { type: 'audio/wav' }),
          notes: 'Original note ' + i,
          transcript: '[00:00] ' + name + ': Prototype discussion ' + i,
          summary: 'Prototype decision ' + i,
          meeting: {
            executive_summary: 'Prototype decision ' + i,
            people: [{ name, role: 'Collaborator' }],
            conversations: [
              {
                title: 'Prototype ' + i,
                summary: 'Prototype decision ' + i,
                people: [{ name }],
                start_ms: 0,
                action_items: [{ task: 'Review prototype ' + i, owner: 'self', status: 'open' }],
              },
            ],
          },
        });
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
}

async function installApi(page) {
  await page.evaluate(() => {
    window.qa = {
      calls: [],
      failure: '',
      signedIn: true,
      uid: 'journey-user',
      delay: false,
      followFailure: false,
    };
    const reply = (data) =>
      new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    window.SynapAuth = {
      isSignedIn: () => qa.signedIn,
      session: () => ({ profile: { uid: qa.uid } }),
      config: () => ({}),
      authedFetch: async (url, options = {}) => {
        if (!url.startsWith('/v1/memory-merges')) return reply({});
        qa.calls.push({ url, method: options.method || 'GET', body: options.body });
        const requestedDay = document.querySelector('#datePicker').value;
        if (qa.delay)
          await new Promise((resolve) => {
            qa.release = resolve;
          });
        if (qa.failure)
          return new Response(JSON.stringify({ error: { message: qa.failure } }), { status: 503 });
        const stored = JSON.parse(localStorage.getItem('qa-cloud-merges') || '[]');
        if (options.method === 'POST') {
          const ids = JSON.parse(options.body).recording_ids;
          const merge = {
            merge_id: 'merge-' + Date.now(),
            source_recording_ids: ids,
            day: requestedDay,
            started_at: new Date().toISOString(),
            memory: {
              title: 'Combined prototype review',
              executive_summary: 'Two prototype decisions.',
            },
            transcript: '[00:00] Alex: First discussion\n[01:00] Blair: Second discussion',
          };
          stored.push(merge);
          localStorage.setItem('qa-cloud-merges', JSON.stringify(stored));
          return reply(merge);
        }
        if (options.method === 'DELETE') {
          localStorage.setItem(
            'qa-cloud-merges',
            JSON.stringify(stored.filter((m) => m.merge_id !== url.split('/').pop())),
          );
          return reply({ unmerged: true });
        }
        const day = new URL(url, location.origin).searchParams.get('day');
        return reply({ merges: stored.filter((m) => m.day === day) });
      },
    };
    window.SynapBackend = {
      people: async () => ({ people: [] }),
      followUps: async () => ({
        follow_ups: [
          {
            id: 'follow-1',
            task: 'Review the prototype',
            state: qa.followState || 'open',
            owner: { type: 'self', display_name: 'You' },
            source: { recording_id: 'journey-0', start_ms: 0 },
          },
        ],
      }),
      resolveFollowUp: async (id, state) => {
        if (qa.followFailure) throw new Error('Could not save follow-up. Please retry.');
        qa.followState = state;
        return { id, state };
      },
    };
  });
  await page.evaluate(async () => {
    SynapCloudHistory.refreshUiInPlace({ source: 'journey-fixture' });
    await SynapMemoryTools.refresh();
    await SynapProvenance.refresh();
    await SynapBrainUI.refresh();
  });
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const q = indexedDB.open('dk-pendant-recordings');
      q.onsuccess = () => resolve(q.result);
    });
    const records = await new Promise((resolve) => {
      const q = db.transaction('recordings').objectStore('recordings').getAll();
      q.onsuccess = () => resolve(q.result);
    });
    db.close();
    return records.map((r) => ({
      id: r.id,
      name: r.name,
      notes: r.notes,
      summary: r.summary,
      transcript: r.transcript,
      bytes: r.blob?.size,
    }));
  });
}

async function run() {
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
        timezoneId: 'Asia/Kolkata',
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.addInitScript((mode) => localStorage.setItem('synap-appearance', mode), mode);
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      await page.clock.install({ time: new Date('2026-09-11T10:00:00Z') });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(origin);
      await page.waitForFunction(() => window.SynapCompactLayout && window.SynapMemoryTools);
      await page.waitForTimeout(600);
      await seed(page);
      await installApi(page);
      await page.waitForFunction(
        () =>
          document.querySelectorAll('#insightsList .insight-card[data-recording-id]').length === 6,
      );
      await page.waitForTimeout(400);
      const before = await snapshot(page);
      assert.equal(before.length, 6);
      assert(
        await page.locator('#insights .section-heading').evaluate((node) => {
          const title = node.querySelector('h2').getBoundingClientRect();
          const count = node.querySelector('#insightsCount').getBoundingClientRect();
          const actions = node.querySelector('.synap-memory-actions').getBoundingClientRect();
          return Math.max(title.right, count.right) <= actions.left && actions.right <= innerWidth;
        }),
        'memory title and actions do not overlap on narrow screens',
      );
      assert(
        await page.locator('#memoryDayPanel #insights').isVisible(),
        'memories belong to the active day view',
      );
      await page.locator('#synapMergeMemories').click();
      assert(
        await page.locator('.synap-merge-toolbar').isVisible(),
        'Merge opens its collapsed tile',
      );
      const checks = page.locator('.synap-merge-check');
      assert.equal(await checks.count(), 6);
      await page.evaluate(() => {
        window.qaMutations = 0;
        window.qaObserver = new MutationObserver((changes) => (qaMutations += changes.length));
        qaObserver.observe(document.querySelector('#insightsList'), {
          childList: true,
          subtree: true,
        });
      });
      await page.waitForTimeout(300);
      assert.equal(
        await page.evaluate(() => {
          qaObserver.disconnect();
          return qaMutations;
        }),
        0,
        'selection settles without a DOM feedback loop',
      );
      await checks.nth(0).click();
      await checks.nth(2).click();
      assert(
        await page.locator('#synapMergeConfirm').isDisabled(),
        'non-consecutive selection blocked',
      );
      await checks.nth(2).click();
      await checks.nth(1).click();
      assert(!(await page.locator('#synapMergeConfirm').isDisabled()));
      for (const i of [2, 3, 4]) await checks.nth(i).click();
      await checks.nth(5).click();
      assert.equal(
        await page.locator('.synap-merge-check[aria-pressed=true]').count(),
        5,
        'cannot select a sixth source',
      );
      for (const i of [2, 3, 4]) await checks.nth(i).click();
      await page.evaluate(() => {
        qa.failure = 'Merge service unavailable. Please retry.';
      });
      await page.locator('#synapMergeConfirm').click();
      await page.waitForFunction(() =>
        document
          .querySelector('#synapMergeError')
          .textContent.includes('Merge service unavailable'),
      );
      await page.waitForTimeout(150);
      assert(await page.locator('#synapMergeError').isVisible(), 'failure remains visible');
      assert.equal(
        await page.locator('.synap-merge-check[aria-pressed=true]').count(),
        2,
        'failure retains selection',
      );
      await page.evaluate(() => {
        qa.failure = '';
      });
      await page.locator('#synapMergeConfirm').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.synap-merged-card').length === 1,
      );
      assert.equal(await page.locator('#insightsCount').innerText(), '5');
      assert.equal(await page.locator('.synap-memory-source-hidden').count(), 2);
      assert.deepEqual(await snapshot(page), before, 'merge preserves all sources and audio');
      assert.deepEqual(
        await page.evaluate(
          () => JSON.parse(qa.calls.filter((c) => c.method === 'POST').at(-1).body).recording_ids,
        ),
        ['journey-1', 'journey-0'],
      );
      const merged = page.locator('.synap-merged-card');
      if (process.env.SYNAP_WORKFLOW_OUTPUT) {
        fs.mkdirSync(process.env.SYNAP_WORKFLOW_OUTPUT, { recursive: true });
        await page.locator('#insights').screenshot({
          path: path.join(process.env.SYNAP_WORKFLOW_OUTPUT, `merge-${mode}-${width}.png`),
        });
      }
      await merged.getByRole('tab', { name: 'Transcript', exact: true }).click();
      assert.match(
        await merged.locator('.synap-provenance-transcript').innerText(),
        /First discussion/,
      );
      await page.evaluate(() =>
        SynapCloudHistory.refreshUiInPlace({ source: 'background-journey' }),
      );
      await page.waitForTimeout(300);
      assert(await merged.evaluate((n) => n.open), 'background refresh preserves merged expansion');
      assert.equal(
        await merged
          .getByRole('tab', { name: 'Transcript', exact: true })
          .getAttribute('aria-selected'),
        'true',
      );
      await merged.locator('.synap-merged-sources button').first().click();
      await page.waitForFunction(() => document.querySelector('#recording-journey-1')?.open);
      assert(await page.locator('#recording-journey-1 .recording-content').isVisible());
      await page.reload();
      await page.waitForFunction(() => window.SynapMemoryTools);
      await page.waitForTimeout(500);
      await installApi(page);
      await page.locator('.brain-tabs a[href="#today"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.synap-merged-card').length === 1,
      );
      await page.locator('.synap-merged-card > summary').click();
      await page.evaluate(() => {
        qa.failure = 'Unmerge failed. Please retry.';
      });
      await page.locator('.synap-unmerge').click();
      await page.waitForFunction(() =>
        document.querySelector('#synapMergeError').textContent.includes('Unmerge failed'),
      );
      assert.equal(await page.locator('.synap-merged-card').count(), 1);
      await page.evaluate(() => {
        qa.failure = '';
      });
      await page.locator('.synap-unmerge').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.synap-merged-card').length === 0,
      );
      assert.equal(await page.locator('.synap-memory-source-hidden').count(), 0);
      assert.deepEqual(
        await snapshot(page),
        before,
        'unmerge restores source views with original data',
      );

      // The canonical memory viewer preserves its selected tab and exact source ID.
      const source = page.locator('#insightsList [data-recording-id="journey-0"]');
      await source.locator('summary.insight-top').click();
      await source.getByRole('tab', { name: 'Notes', exact: true }).click();
      await page.evaluate(() => SynapProvenance.refresh());
      assert.equal(
        await source.getByRole('tab', { name: 'Notes', exact: true }).getAttribute('aria-selected'),
        'true',
      );
      assert.equal(await source.locator('.synap-memory-view').count(), 1);
      assert.match(await source.locator('.synap-note-body').innerText(), /Original note 0/);
      await page.locator('.brain-tabs a[href="#library"]').click();
      await page.locator('[data-library-scope="all"]').click();
      await page.locator('#librarySearch').fill('Original note 3');
      await page.waitForFunction(
        () => document.querySelector('#librarySearchStatus').textContent === '1 matching recording',
      );
      await page.locator('#recording-journey-3 > summary').click();
      await page.locator('#recording-journey-3 .recording-content').waitFor({ state: 'visible' });
      await page.locator('#clearLibrarySearch').click();

      // Person recall must actually answer in local mode, without a second tap on Ask.
      await page.evaluate(async () => {
        qa.signedIn = false;
        await SynapInteractionSurfaces.refresh();
        SynapCompactLayout.reveal('peopleMemory');
      });
      await page.waitForFunction(() => document.querySelectorAll('.person-card').length >= 3);
      await page.locator('#peopleBrowseToggle').click();
      await page.locator('#peopleSearch input').fill('Alex');
      await page.locator('.person-card').click();
      await page.waitForFunction(() => document.querySelector('#askAnswer .answer-sources'));
      assert.match(await page.locator('#askAnswer').innerText(), /Prototype/);
      await page.locator('#askAnswer .source-jump').first().click();
      await page.waitForFunction(() => document.querySelector('#recording-journey-0')?.open);

      // A failed account action stays actionable and tells the user what failed.
      await page.evaluate(async () => {
        qa.signedIn = true;
        await SynapInteractionSurfaces.refresh(true);
        SynapCompactLayout.reveal('followupInbox');
        qa.followFailure = true;
      });
      await page.locator('#followupList [data-followup-id="follow-1"]').click();
      await page.waitForFunction(() =>
        document
          .querySelector('#actionUpdateStatus')
          ?.textContent.includes('Could not save follow-up'),
      );
      assert(await page.locator('#actionUpdateStatus').isVisible());
      await page.evaluate(() => {
        qa.followFailure = false;
      });
      await page.locator('#followupList [data-followup-id="follow-1"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('#followupList [data-followup-id="follow-1"]').length === 0,
      );
      assert.equal(await page.locator('#followupCount').innerText(), '5');

      // Leaving a day during an in-flight merge must not insert its result on the new day.
      await page.locator('.brain-tabs a[href="#today"]').click();
      await page.evaluate(() => SynapMemoryTools.refresh());
      await page.locator('#synapMergeMemories').click();
      await checks.nth(0).click();
      await checks.nth(1).click();
      await page.evaluate(() => {
        qa.delay = true;
      });
      await page.locator('#synapMergeConfirm').click();
      await page.waitForFunction(() => qa.release);
      await page.locator('[data-day-step="-1"]').click();
      await page.evaluate(() => {
        qa.delay = false;
        qa.release();
      });
      await page.waitForTimeout(300);
      assert.equal(
        await page.locator('.synap-merged-card').count(),
        0,
        'stale merge cannot pollute another day',
      );
      assert.equal(await page.locator('.synap-merge-check').count(), 0);
      // Source quotations share the Actions panel and wrap as rectangular rows.
      await page.evaluate(async () => {
        const previous = SynapAuth.authedFetch;
        SynapAuth.authedFetch = async (url, options) =>
          url.includes('/ask')
            ? new Response(
                JSON.stringify({
                  answer: 'We discussed the brand.\nThe next step is reviewing supply.',
                  confidence: 'high',
                  searched: { conversations: 2 },
                  sources: [
                    {
                      recording_id: 'journey-0',
                      start_ms: 7000,
                      quote: 'co-founder of Stitch Lane, a D2C streetwear brand',
                    },
                    {
                      recording_id: 'journey-1',
                      start_ms: 0,
                      quote:
                        "We focus on high-margin SKUs, and we've recently optimized our supply chain through just-in-time manufacturing to reduce dead stock.",
                    },
                  ],
                }),
              )
            : previous(url, options);
        SynapDashboardUI.setView('ask');
        await SynapAsk.ask('What did we discuss?');
      });
      const cards = page.locator('#askAnswer .ask-source');
      assert.equal(await cards.count(), 2);
      const sourceLayout = await cards.evaluateAll((nodes) =>
        nodes.map((node) => ({
          rect: node.getBoundingClientRect().toJSON(),
          radius: getComputedStyle(node).borderRadius,
          overflow: node.scrollWidth > node.clientWidth,
        })),
      );
      assert(sourceLayout.every((item) => item.radius === '12px' && !item.overflow));
      assert(
        sourceLayout[1].rect.y >= sourceLayout[0].rect.bottom,
        'quotes are stacked, never squeezed into circles',
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await cards.last().scrollIntoViewIfNeeded();
      if (process.env.SYNAP_WORKFLOW_OUTPUT)
        await page.locator('#myActions').screenshot({
          path: path.join(process.env.SYNAP_WORKFLOW_OUTPUT, `sources-${mode}-${width}.png`),
        });
      assert.deepEqual(errors, [], 'no uncaught page errors');
      console.log(
        `PASS workflows/${mode}/${width}: merge/retry/reload/unmerge, unchanged sources, stable tabs, search, People recall, follow-up retry, day-change race`,
      );
      if (process.env.SYNAP_WORKFLOW_OUTPUT) {
        fs.mkdirSync(process.env.SYNAP_WORKFLOW_OUTPUT, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.SYNAP_WORKFLOW_OUTPUT, `${mode}-${width}.png`),
          fullPage: true,
        });
      }
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
