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
        await page.waitForFunction(() => document.body.dataset.startup === 'ready');
        const tabs = page.locator('.actions-tabs > [role="tab"]');
        assert.deepEqual(await tabs.allTextContents(), ['Next steps', 'Follow-ups', 'People']);
        await page.locator('.brain-tabs a[href="#ask"]').click();
        await page.locator('#askInput').fill('Keep this draft while I check my actions');
        await page.evaluate(() => {
          window.qaActionNodes = [
            ...document.querySelectorAll('#myActions [data-actions-panel],#askForm,#askInput'),
          ];
          window.qaHeader = document.querySelector('.topbar');
        });
        await page.locator('.brain-tabs a[href="#myActions"]').click();
        for (let i = 0; i < 3; i++) {
          await tabs.nth(i).click();
          assert.equal(await page.locator('.actions-tabs [aria-selected="true"]').count(), 1);
          const id = await tabs.nth(i).getAttribute('aria-controls');
          assert(await page.locator('#' + id).isVisible());
          assert.equal(await page.locator('#myActions [data-actions-panel]:visible').count(), 1);
          const bounds = await tabs.nth(i).boundingBox();
          assert(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          await page.screenshot({ path: path.join(out, `actions-${id}-${mode}-${width}.png`) });
        }
        await page.keyboard.press('Home');
        assert.equal(
          await page.locator('#actionsTab-dailyFocus').getAttribute('aria-selected'),
          'true',
        );
        await page.keyboard.press('ArrowLeft');
        assert.equal(
          await page.evaluate(() => document.activeElement.id),
          'actionsTab-peopleMemory',
        );
        await page.keyboard.press('ArrowRight');
        await page.locator('#focusCommitments').focus();
        await page.keyboard.press('ArrowRight');
        assert(await page.locator('#focusDecisionsPanel').isVisible());
        await page.locator('#actionsTab-followupInbox').click();
        await page.locator('[data-follow="waiting"]').click();
        await page.locator('.brain-tabs a[href="#ask"]').click();
        assert.equal(
          await page.locator('#askInput').inputValue(),
          'Keep this draft while I check my actions',
        );
        await page.evaluate(() => {
          const p = document.createElement('p');
          p.id = 'qaLongAnswer';
          p.textContent = 'A long answer remains readable in the page. '.repeat(300);
          document.getElementById('askAnswer').appendChild(p);
          scrollTo(0, 350);
        });
        const position = await page.evaluate(() => scrollY);
        assert(position > 0);
        await page.locator('.brain-tabs a[href="#myActions"]').click();
        assert(
          await page
            .locator('[data-follow="waiting"]')
            .evaluate((n) => n.classList.contains('active')),
        );
        await page.locator('.brain-tabs a[href="#ask"]').click();
        assert.equal(
          await page.evaluate(() => scrollY),
          position,
          'return to Ask restores reading position',
        );
        await page.evaluate(() => document.getElementById('qaLongAnswer').remove());
        await page.evaluate(() => SynapCompactLayout.reveal('peopleMemory'));
        assert(await page.locator('#peopleMemory').isVisible());
        await page.evaluate(() => (location.hash = '#dailyFocus'));
        await page.waitForFunction(
          () =>
            document.body.dataset.synapView === 'actions' &&
            !document.getElementById('dailyFocus').hidden,
        );
        assert(await page.locator('#focusDecisionsPanel').isVisible());
        assert(
          await page.evaluate(
            () =>
              qaActionNodes.every(
                (node) => node.isConnected && document.getElementById(node.id) === node,
              ) && qaHeader === document.querySelector('.topbar'),
          ),
        );
        assert.deepEqual(errors, []);
        console.log(
          `PASS actions/${mode}/${width}: mounted destinations, preserved reading and drafts, action filters, keyboard tabs, source deep links and persistent header`,
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
