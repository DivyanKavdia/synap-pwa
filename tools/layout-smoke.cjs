'use strict';
// Capture every breakpoint before evaluating density, so a layout failure still
// leaves a complete, reviewable gallery and computed geometry in the CI artifact.
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = path.resolve('artifacts/workflows/layout');
const server = createStaticServer(path.resolve(__dirname, '..'));
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  const measurements = [],
    failures = [];
  fs.mkdirSync(out, { recursive: true });
  try {
    for (const width of [320, 390, 768, 1440])
      for (const mode of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          reducedMotion: 'reduce',
        });
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        await context.addInitScript((mode) => localStorage.setItem('synap-appearance', mode), mode);
        const page = await context.newPage();
        page.on('pageerror', (error) => failures.push(`${width}/${mode}: ${error.message}`));
        await page.goto(origin);
        await page.waitForFunction(
          () =>
            document.body.dataset.startup === 'ready' && document.querySelector('#myActionsContent'),
        );
        const measure = async (screen, selectors) => {
          const data = await page.evaluate(
            (selectors) =>
              selectors.map((selector) => {
                const node = document.querySelector(selector),
                  r = node.getBoundingClientRect(),
                  style = getComputedStyle(node);
                return {
                  selector,
                  x: r.x,
                  y: r.y,
                  width: r.width,
                  height: r.height,
                  padding: style.padding,
                  margin: style.margin,
                  display: style.display,
                  gap: style.gap,
                  font: style.font,
                  minHeight: style.minHeight,
                };
              }),
            selectors,
          );
          measurements.push({ width, mode, screen, data });
          if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
            failures.push(`${width}/${mode}/${screen}: horizontal overflow`);
          await page.screenshot({
            path: path.join(out, `${screen}-${mode}-${width}.png`),
            fullPage: screen === 'home',
          });
          return data;
        };
        const home = await measure('home', [
          '.topbar',
          'main',
          '#memoryWorkspace',
          '#memoryDayPanel',
          '.brain-heading',
          '#firstMemory',
          '.first-memory-layout',
          '#firstMemoryTitle',
          '#firstMemoryCopy',
          '.first-memory-actions',
          '#firstMemoryRecord',
          '#firstMemoryHint',
          '#firstMemoryAccount',
          '#firstMemorySample',
          '#myActions',
          '#myActionsContent',
          '#library',
        ]);
        if (
          home.find((x) => x.selector === '#memoryWorkspace').height >= (width >= 760 ? 420 : 570)
        )
          failures.push(`${width}/${mode}: welcome is too tall`);
        if (home.find((x) => x.selector === '#myActionsContent').height >= 215)
          failures.push(`${width}/${mode}: short Actions panel reserves empty space`);
        assert.equal(await page.locator('main > section:visible').count(), 1, 'one destination fills the workspace');
        await page.locator('#settingsButton').click();
        for (const section of ['device', 'memory', 'appearance', 'support']) {
          await page.locator('#settingsTab-' + section).click();
          await measure('settings-' + section, [
            '#settingsDialog',
            '.settings-form',
            '#settingsDialog .modal-header',
            '.settings-tabs',
            '[data-settings-panel="' + section + '"]',
          ]);
        }
        await context.close();
      }
    fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(measurements, null, 2));
    console.log(
      JSON.stringify(
        measurements.map(({ width, mode, screen, data }) => ({
          width,
          mode,
          screen,
          geometry: data.filter((x) =>
            ['#memoryWorkspace', '#myActionsContent'].includes(x.selector),
          ),
        })),
      ),
    );
    assert.deepEqual(failures, [], 'responsive layout review');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server.close();
});
