/* One memory card and durable local actions, exercised through the real shell and IndexedDB. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(path.resolve(__dirname, '..'));
const output = path.resolve(__dirname, '../artifacts/workflows/memory-workspace');

async function assertPeriod(page, period) {
  const week = period === 'week';
  assert.equal(await page.locator('#memoryDayPanel').isVisible(), !week);
  assert.equal(await page.locator('#memoryWeekPanel').isVisible(), week);
  assert.equal(await page.locator('#memoryTab-' + period).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.brain-tabs a[aria-current="page"]').count(), 1);
  assert.equal(
    await page.locator('.brain-tabs a[aria-current="page"]').getAttribute('href'),
    week ? '#memoryWeekPanel' : '#today',
  );
}

async function checkPeriodNavigation(page) {
  const selectedDate = await page.locator('#datePicker').inputValue();
  await page.getByRole('link', { name: 'Weekly', exact: true }).click();
  await assertPeriod(page, 'week');
  // Let the navigation lock expire, then reproduce viewport and background updates.
  await page.waitForTimeout(950);
  await page.evaluate(async () => {
    scrollTo(0, 0);
    dispatchEvent(new Event('scroll'));
    dispatchEvent(new Event('resize'));
    dispatchEvent(new Event('synap-processing-state'));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await assertPeriod(page, 'week');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await assertPeriod(page, 'day');
  await page.locator('#memoryTab-week').click();
  await assertPeriod(page, 'week');
  await page.locator('#memoryTab-day').click();
  await assertPeriod(page, 'day');
  assert.equal(await page.locator('#datePicker').inputValue(), selectedDate);
}

async function run() {
  fs.mkdirSync(output, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    for (const [theme, width] of [
      ['light', 320],
      ['dark', 390],
      ['light', 1440],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        timezoneId: 'America/Los_Angeles',
        reducedMotion: 'reduce',
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.addInitScript((theme) => {
        localStorage.setItem('synap-appearance', theme);
        localStorage.setItem('dk-pendant-settings', JSON.stringify({ autoProcess: false }));
      }, theme);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(10000);
      await page.goto(origin);
      await page.waitForFunction(() => document.body.dataset.startup === 'ready');
      await checkPeriodNavigation(page);
      for (const [fragment, period] of [
        ['memoryWeekPanel', 'week'],
        ['synapWeeklyReview', 'week'],
        ['insights', 'day'],
      ]) {
        await page.goto(origin + '/?navigation=' + fragment + '#' + fragment);
        await page.waitForFunction(() => document.body.dataset.startup === 'ready');
        await page.waitForFunction((period) => SynapMemoryWorkspace.period === period, period);
        await assertPeriod(page, period);
      }
      await page.evaluate(async () => {
        const api = SynapActionState,
          now = new Date(),
          today = api.day(now);
        const lastWeek = api.range('last-week')[0],
          nextWeek = api.range('next-week')[0];
        const later = new Date(now);
        later.setDate(later.getDate() + 21);
        const recording = {
          id: 'workspace-today',
          name: 'Project conversation',
          createdAt: now.toISOString(),
          durationMs: 10000,
          sealed: true,
          status: 'saved',
          blob: DKAudioCodec.wav([new Uint8Array(320000)]),
          summary: 'We agreed on a prototype and the next review.',
          transcript: '[00:02] Asha: Send the prototype today.',
          notes: 'Keep my note',
          meeting: {
            people: [{ name: 'Asha' }, { name: '李雷' }],
            conversations: [
              {
                title: 'Prototype review',
                summary: 'Prototype and review dates agreed.',
                start_ms: 2000,
                decisions: [{ text: 'Build a prototype', start_ms: 2000 }],
                action_items: [
                  { task: 'Send prototype', owner: 'self', due_date: today, start_ms: 2000 },
                  {
                    task: 'Prepare next review',
                    owner: 'self',
                    due_date: nextWeek,
                    start_ms: 3000,
                  },
                  { task: 'Explore ideas', owner: 'self', start_ms: 4000 },
                ],
              },
            ],
          },
        };
        const old = {
          ...recording,
          id: 'workspace-older',
          createdAt: lastWeek + 'T12:00:00',
          name: 'Older conversation',
          meeting: {
            action_items: [
              { task: 'Earlier deadline', owner: 'self', due_date: lastWeek, start_ms: 1000 },
              { task: 'Monthly check-in', owner: 'self', due_date: api.day(later), start_ms: 2000 },
            ],
          },
        };
        await new DKAudioStore().atomic(['recordings'], (stores) => {
          stores.recordings.put(recording);
          stores.recordings.put(old);
        });
        SynapCloudHistory.refreshUiInPlace({ source: 'workspace-fixture' });
        await SynapBrainUI.refresh();
        await SynapProductivity.refresh(false);
        await SynapInteractionSurfaces.refresh();
      });
      await page.locator('#memoryDayPanel #insights .insight-card').waitFor();
      assert.equal(await page.locator('#dayLensTitle').innerText(), 'My day at a glance');
      const selectedDay = await page.locator('#datePicker').inputValue();
      assert.equal(await page.locator('#brainDateLine').getAttribute('datetime'), selectedDay);
      assert.equal(await page.locator('#glanceRecordings').innerText(), '1');
      assert.equal(await page.locator('#glanceDuration').innerText(), '<1m');
      assert.equal(await page.locator('#glanceConversations').innerText(), '1');
      assert.equal(await page.locator('#glanceDecisions').innerText(), '1');
      const dayControls = await page
        .locator('.day-navigation button')
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
      assert(dayControls.every((rect) => rect.width >= 44 && rect.height >= 44));
      assert(dayControls.every((rect) => Math.abs(rect.y - dayControls[0].y) < 1));
      const metrics = await page
        .locator('#dayGlanceMetrics > * > strong')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
      assert.equal(metrics.length, 3);
      assert(
        metrics.every((rect) => Math.abs(rect.y - metrics[0].y) < 1),
        'activity totals align',
      );
      const labels = await page.locator('#dayGlanceMetrics > * > span').evaluateAll((nodes) =>
        nodes.map((node) => ({
          height: node.getBoundingClientRect().height,
          line: parseFloat(getComputedStyle(node).lineHeight),
        })),
      );
      await page.screenshot({ path: path.join(output, `glance-${theme}-${width}.png`) });
      assert(
        labels.every((label) => label.height <= label.line + 1),
        'activity labels fit on mobile: ' + JSON.stringify(labels),
      );
      await page.locator('#dayGlanceConversations').click();
      assert.equal(
        await page.locator('#dayConversations .tile-toggle').getAttribute('aria-expanded'),
        'true',
      );
      assert(await page.locator('#conversationList').isVisible());
      await page.locator('#dayGlanceRecordings').click();
      await page.waitForFunction(
        () => document.querySelectorAll('#recordingsList .recording-card').length === 1,
      );
      assert.equal(
        await page.locator('[data-library-scope="day"]').getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(
        await page.locator('#recordingsList .recording-card').getAttribute('id'),
        'recording-workspace-today',
      );
      assert.equal(await page.locator('#datePicker').inputValue(), selectedDay);
      await page.getByRole('link', { name: 'Today', exact: true }).click();
      assert.equal(await page.locator('main > #insights, main > #synapWeeklyReview').count(), 0);
      await page.evaluate(() => {
        window.memoryCard = document.querySelector('#insights .insight-card');
        memoryCard.open = true;
      });
      await checkPeriodNavigation(page);
      await page.locator('#memoryTab-day').focus();
      await page.keyboard.press('ArrowRight');
      await assertPeriod(page, 'week');
      assert(!(await page.locator('#today').isVisible()));
      await page.keyboard.press('Home');
      await assertPeriod(page, 'day');
      assert(
        await page.evaluate(
          () => memoryCard === document.querySelector('#insights .insight-card') && memoryCard.open,
        ),
        'tabs keep the memory card and reading state',
      );
      await page.keyboard.press('End');
      await page.locator('#memoryWeekPanel .synap-week-source').first().waitFor();
      assert(await page.locator('.memory-timeline-day').count());
      await page.locator('#previousMemoryWeek').click();
      await page.locator('#currentMemoryWeek').waitFor();
      const weekControls = await page
        .locator('.memory-week-navigation button')
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
      assert.equal(weekControls.length, 4);
      assert(weekControls.every((rect) => rect.width >= 44 && rect.height >= 44));
      assert(
        weekControls.every((rect) => Math.abs(rect.y - weekControls[0].y) < 1),
        'week arrows, This week and Refresh stay on one row',
      );
      await page.locator('#currentMemoryWeek').click();
      assert(await page.locator('#nextMemoryWeek').isDisabled());
      assert(await page.locator('#currentMemoryWeek').isDisabled());
      await page.locator('#synapRefreshWeek').click();
      await page.locator('#memoryWeekPanel .synap-week-source').first().waitFor();
      await page.screenshot({ path: path.join(output, `weekly-${theme}-${width}.png`) });
      await page.locator('#memoryTab-week').focus();
      await page.keyboard.press('Home');
      await page.evaluate(() => SynapCompactLayout.reveal('synapWeeklyReview'));
      await assertPeriod(page, 'week');
      assert(
        await page.locator('#memoryWeekPanel').isVisible(),
        'source reveal selects its period',
      );
      await page.locator('.brain-tabs a[href="#today"]').click();
      assert(await page.locator('#memoryDayPanel').isVisible());
      await page.screenshot({ path: path.join(output, `daily-${theme}-${width}.png`) });
      await page.locator('.brain-tabs a[href="#myActions"]').click();
      await page.locator('#actionsTab-dailyFocus').click();
      for (const [period, count] of [
        ['all', 5],
        ['today', 2],
        ['last-week', 1],
        ['next-week', 1],
        ['next-month', 3],
        ['overdue', 1],
        ['undated', 1],
      ]) {
        await page.locator('#actionsTimeline').selectOption(period);
        assert.equal(
          await page.locator('#commitmentList .synap-follow-row').count(),
          count,
          period,
        );
      }
      await page.locator('#actionsTimeline').selectOption('next-week');
      await page.getByRole('link', { name: 'Today', exact: true }).click();
      await page.locator('#dayGlanceNextSteps').click();
      assert.equal(
        await page.locator('#actionsTab-dailyFocus').getAttribute('aria-selected'),
        'true',
      );
      assert.equal(await page.locator('#actionsTimeline').inputValue(), 'next-week');
      await page.evaluate(() => {
        const picker = document.getElementById('datePicker');
        picker.value = SynapActionState.range('last-week')[0];
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForFunction(
        () =>
          document.getElementById('brainDateLine').dateTime ===
          document.getElementById('datePicker').value,
      );
      assert.equal(await page.locator('#glanceDecisions').textContent(), '0');
      assert.match(
        await page.locator('#commitmentList').innerText(),
        /Prepare next review/,
        'older memory selection does not change task deadlines',
      );
      await page.locator('#commitmentList .synap-follow-done').click();
      await page.waitForFunction(
        () => document.getElementById('commitmentCount').textContent === '0',
      );
      await page.locator('#actionsState').selectOption('done');
      await page.locator('#commitmentList .synap-follow-done').waitFor();
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.startup === 'ready');
      await page.locator('.brain-tabs a[href="#myActions"]').click();
      await page.locator('#actionsTab-dailyFocus').click();
      await page.locator('#actionsTimeline').selectOption('next-week');
      await page.locator('#actionsState').selectOption('done');
      await page.locator('#commitmentList .synap-follow-done').waitFor();
      assert.match(await page.locator('#commitmentList').innerText(), /Prepare next review/);
      await page.screenshot({ path: path.join(output, `actions-${theme}-${width}.png`) });
      await page.locator('#commitmentList .synap-follow-done').click();
      await page.waitForFunction(
        () => document.getElementById('commitmentCount').textContent === '0',
      );
      await page.locator('#actionsState').selectOption('open');
      await page.locator('#commitmentList .synap-follow-done').waitFor();
      await page.locator('#actionsTab-peopleMemory').click();
      const person = page
        .locator('.person-entry')
        .filter({ has: page.locator('[data-person="李雷"]') });
      await person.locator('summary').click();
      await person.getByRole('button', { name: 'Delete person', exact: true }).click();
      await person.getByRole('button', { name: 'Keep person', exact: true }).click();
      assert(await person.isVisible());
      await person.getByRole('button', { name: 'Delete person', exact: true }).click();
      await person.getByRole('button', { name: 'Delete person', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#peopleList [data-person="李雷"]'));
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.startup === 'ready');
      await page.locator('.brain-tabs a[href="#myActions"]').click();
      await page.locator('#actionsTab-peopleMemory').click();
      await page.locator('#peopleList [data-person="Asha"]').waitFor();
      assert.equal(
        await page.locator('#peopleList [data-person="李雷"]').count(),
        0,
        'local deletion survives reload without hiding other names',
      );
      const preserved = await page.evaluate(async () => {
        const r = await new DKAudioStore().get('recordings', 'workspace-today');
        return { notes: r.notes, transcript: r.transcript, audio: r.blob.size };
      });
      assert.equal(preserved.notes, 'Keep my note');
      assert.match(preserved.transcript, /Asha/);
      assert(preserved.audio > 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS memory workspace/${theme}/${width}: tabs, source identity, week navigation, independent action dates, completion/reopen/reload and People deletion preserve recordings`,
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
