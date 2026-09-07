const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'recording-bridge.js'), 'utf8');
const ai = fs.readFileSync(path.join(__dirname, '..', 'ai-providers.js'), 'utf8');
const theme = fs.readFileSync(path.join(__dirname, '..', 'theme.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

const rollover = Number(source.match(/const ROLLOVER_MS = (\d+) \* 60 \* 1000/)?.[1]);
assert.equal(rollover, 45, 'continuous capture rolls before 16-bit sequence wrap');
assert(rollover < (65536 * 50 / 60000), 'rollover must stay below protocol wrap');
assert.match(source, /function adoptHardwareStream\(\)/);
assert.match(source, /if \(state === '2'\)/);
assert.match(source, /attempts >= 40/);
assert.match(source, /start\.click\(\)/, 'hardware STREAMING state opens the browser journal');
assert.match(source, /stop\.click\(\)/, 'long capture performs a controlled rollover');
assert.match(source, /continuousGroupId/);
assert.match(source, /continuousPart/);
assert.match(source, /Touch: double tap to start\/stop · hold 5s to sleep · triple tap to wake/);
assert.match(theme, /recording-bridge\.js\?v=1\.0\.0-touch4/);
assert.match(worker, /\.\/recording-bridge\.js/);
assert.match(ai, /continuousContext/);
assert.match(ai, /one continuous conversation/);
assert.match(ai, /continuous-45m-parts-30s-stt-5m-blocks-final/);

assert.match(source, /AUTO_RECONNECT_KEY = 'dk-pendant-auto-reconnect'/);
assert.match(source, /POWER_STATE_DEEP_SLEEP = 3/);
assert.match(source, /function beginIntentionalSleep\(\)/);
assert.match(source, /localStorage\?\.setItem\(AUTO_RECONNECT_KEY, 'off'\)/,
  'deep-sleep notification must disable the app reconnect path before GATT disconnect');
assert.match(source, /if \(bytes\[2\] === POWER_STATE_DEEP_SLEEP\) beginIntentionalSleep\(\)/);
assert.match(source, /synap-event-packet/);
assert.match(source, /data-intentional-sleep|dataset\.intentionalSleep/);
assert.match(source, /synap-gatt-service-ready/);
assert.match(source, /if \(intentionalSleep\) endIntentionalSleep\(\)/,
  'the saved reconnect preference is restored only after a real connection returns');

console.log('PASS: hardware journal adoption, intentional-sleep reconnect guard, triple-tap wake copy, rollover and continuous AI consolidation.');
