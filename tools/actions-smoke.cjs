/* Exercise the shared action workspace in the real app shell. */
'use strict';
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..'),
  out = process.env.SYNAP_ACTIONS_OUTPUT || '/tmp/synap-actions-qa';

const server = createStaticServer(root);
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    for (const mode of ['light', 'dark'])
      for (const width of [320, 390, 1440]) {
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
        await page.waitForFunction(() => document.getElementById('myActionsBody'));
        const tabs = page.locator('.actions-tabs > [role="tab"]'),
          panels = page.locator('#myActions [data-actions-panel]');
        assert.deepEqual(await tabs.allTextContents(), [
          'Ask Synap',
          'Next steps',
          'Follow-ups',
          'People',
        ]);
        assert.equal(await panels.count(), 4);
        assert.equal(
          await page
            .locator(
              'main > #ask,main > #peopleMemory,main > #followupInbox,#today #dailyFocus,.brain-tabs a[href="#ask"]',
            )
            .count(),
          0,
        );
        assert.equal(await page.locator('#myActionsTitle').innerText(), 'My actions');
        await page.locator('.brain-tabs a[href="#myActions"]').click();
        const initial = await page.locator('#myActions').boundingBox();
        assert.equal(
          await page.locator('#myActionsContent > [data-actions-panel]').count(),
          4,
          'all four panels belong to one content area',
        );
        assert.equal(
          await page.locator('#myActionsContent .section-card').count(),
          0,
          'panels are not separate cards',
        );
        await page.locator('#askInput').fill('Keep this draft while I check my actions');
        await page.evaluate(() => {
          window.qaActionNodes = [
            ...document.querySelectorAll('#myActions [data-actions-panel],#askForm,#askInput'),
          ];
          window.qaHeader = document.querySelector('.topbar');
        });
        for (let i = 0; i < 4; i++) {
          await tabs.nth(i).click();
          assert.equal(await page.locator('.actions-tabs [aria-selected="true"]').count(), 1);
          assert.equal(await page.locator('.actions-tabs [tabindex="0"]').count(), 1);
          const id = await tabs.nth(i).getAttribute('aria-controls');
          assert(await page.locator('#' + id).isVisible());
          assert.equal(await page.locator('#myActions [data-actions-panel]:visible').count(), 1);
          const card = await page.locator('#myActions').boundingBox();
          for (const key of ['x', 'width'])
            assert(
              Math.abs(card[key] - initial[key]) < 1,
              'switching stays in the same card: ' + key,
            );
          const content = await page.locator('#myActionsContent').boundingBox(),
            strip = await page.locator('.actions-tabs').boundingBox();
          assert(
            Math.abs(
              strip.y +
                strip.height +
                ((await page.locator('#actionFilters').isVisible())
                  ? (await page.locator('#actionFilters').boundingBox()).height
                  : 0) -
                content.y,
            ) < 1,
            'tabs are attached to their content area',
          );
          assert.equal(
            await page.locator('.brain-tabs [aria-current="page"]').getAttribute('href'),
            '#myActions',
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          const bounds = await tabs.nth(i).boundingBox();
          assert(
            bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width,
            'touch target fits viewport',
          );
          if (i === 0 || width === 390)
            await page.screenshot({ path: path.join(out, `actions-${id}-${mode}-${width}.png`) });
        }
        await page.keyboard.press('Home');
        assert.equal(await page.locator('#actionsTab-ask').getAttribute('aria-selected'), 'true');
        assert.equal(
          await page.locator('#askInput').inputValue(),
          'Keep this draft while I check my actions',
        );
        await page.evaluate(() => {
          const answer = document.getElementById('askAnswer');
          const text = document.createElement('p');
          text.textContent = 'A long answer should scroll inside My actions. '.repeat(100);
          answer.appendChild(text);
          document.getElementById('myActionsContent').scrollTop = 180;
        });
        const readingPosition = await page
          .locator('#myActionsContent')
          .evaluate((node) => node.scrollTop);
        assert(readingPosition > 0, 'long answers remain scrollable inside the shared area');
        await page.locator('#actionsTab-peopleMemory').click();
        assert.equal(
          await page.locator('#myActionsContent').evaluate((node) => node.scrollTop),
          0,
          'each tab starts at its own reading position',
        );
        await page.locator('#actionsTab-ask').click();
        assert.equal(
          await page.locator('#myActionsContent').evaluate((node) => node.scrollTop),
          readingPosition,
          'returning to a tab preserves its reading position',
        );
        await page.evaluate(() => {
          document.querySelector('#askAnswer p:last-child').remove();
          document.getElementById('myActionsContent').scrollTop = 0;
        });
        await page.keyboard.press('ArrowLeft');
        assert.equal(
          await page.evaluate(() => document.activeElement.id),
          'actionsTab-peopleMemory',
        );
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'actionsTab-dailyFocus');
        await page.locator('#focusCommitments').focus();
        await page.keyboard.press('ArrowRight');
        assert(await page.locator('#focusDecisionsPanel').isVisible());
        await page.evaluate(() => {
          const picker = document.getElementById('datePicker');
          picker.value = '2026-09-07';
          picker.dispatchEvent(new Event('change', { bubbles: true }));
        });
        assert.equal(
          await page.locator('#actionsTimeline').inputValue(),
          'all',
          'memory date changes do not alter the Actions timeline',
        );
        assert(
          await page.locator('#focusDecisionsPanel').isVisible(),
          'inner selection survives a day refresh',
        );
        await page.locator('#actionsTab-followupInbox').click();
        await page.locator('[data-follow="waiting"]').click();
        await page.locator('#actionsTab-ask').click();
        await page.locator('#actionsTab-followupInbox').click();
        assert(
          await page
            .locator('[data-follow="waiting"]')
            .evaluate((node) => node.classList.contains('active')),
          'follow-up filter survives a tab switch',
        );
        await page.locator('#myActions > .tile-heading .tile-toggle').click();
        assert(!(await page.locator('#myActionsBody').isVisible()));
        await page.evaluate(() => SynapCompactLayout.reveal('peopleMemory'));
        assert(await page.locator('#peopleMemory').isVisible());
        await page.evaluate(() => SynapDashboardUI.setView('ask'));
        assert(
          await page.locator('#askInput').isVisible(),
          'existing Ask entry points choose its tab',
        );
        await page.evaluate(() => (location.hash = '#dailyFocus'));
        await page.waitForFunction(() => !document.getElementById('dailyFocus').hidden);
        assert(
          await page.locator('#focusDecisionsPanel').isVisible(),
          'deep links retain the nested selection',
        );
        assert(
          await page.evaluate(
            () =>
              qaActionNodes.every(
                (node) => node.isConnected && document.getElementById(node.id) === node,
              ) && qaHeader === document.querySelector('.topbar'),
          ),
          'same controls and header after all transitions',
        );
        await page.locator('#settingsButton').click();
        assert(await page.locator('#headerCaptureToggle').isVisible());
        await page.locator('.brain-tabs a[href="#myActions"]').click();
        assert(!(await page.locator('#settingsDialog').evaluate((node) => node.open)));
        assert(
          await page.locator('#dailyFocus').isVisible(),
          'Actions navigation preserves the selected panel',
        );
        assert.deepEqual(errors, []);
        console.log(
          `PASS actions/${mode}/${width}: one stable card, attached tabs, shared scrolling, draft/filter retention, day changes, keyboard tabs, deep links and persistent header`,
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
