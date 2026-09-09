const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'recording-bridge.js'), 'utf8');
const capture = fs.readFileSync(path.join(__dirname, '..', 'capture-stability.js'), 'utf8');
const theme = fs.readFileSync(path.join(__dirname, '..', 'theme.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

assert.match(source, /const ROLLOVER_MS = 0/,
  'a user recording must not be stopped and restarted into synthetic parts');
assert.match(source, /SPLIT_RECORDINGS: false/);
assert.doesNotMatch(source, /continuousGroupId|continuousPart|Part ' \+ part/);
assert.doesNotMatch(source, /stop\.click\(\)/,
  'the hardware bridge must never manufacture a file boundary');
assert.match(source, /function adoptHardwareStream\(\)/);
assert.match(source, /if \(state === '2'\)/);
assert.match(source, /attempts >= 40/);
assert.match(source, /start\.click\(\)/,
  'hardware STREAMING state still opens the browser journal');
assert.match(source, /Touch: double tap to start\/stop · triple tap to sleep\/wake/);
assert.doesNotMatch(source, /hold 5s to sleep|hold 5s to sleep\/wake/);
assert.match(theme, /recording-bridge\.js\?v=1\.0\.0-touch5/);
assert.match(worker, /\.\/recording-bridge\.js/);

assert.match(capture, /monotonically increasing/);
assert.match(capture, /beginTransportEpoch/);
assert.doesNotMatch(capture, /advanceContinuousPart|resumeStarted|start\.click\(\)/,
  'BLE recovery must not synthesize a new recording');
assert.match(capture, /LEGACY_CONTINUOUS_KEY/);

assert.match(source, /AUTO_RECONNECT_KEY = 'dk-pendant-auto-reconnect'/);
assert.match(source, /POWER_STATE_DEEP_SLEEP = 3/);
assert.match(source, /SLEEP_RECONNECT_GUARD_MS = 1500/);
assert.match(source, /function beginIntentionalSleep\(\)/);
assert.match(source, /localStorage\?\.setItem\(AUTO_RECONNECT_KEY, 'off'\)/,
  'deep-sleep notification must disable the app reconnect path before GATT disconnect');
assert.match(source, /if \(bytes\[2\] === POWER_STATE_DEEP_SLEEP\) beginIntentionalSleep\(\)/);
assert.match(source, /synap-event-packet/);
assert.match(source, /data-intentional-sleep|dataset\.intentionalSleep/);
assert.match(source, /function scheduleReconnectPreferenceRestore\(\)/);
assert.match(source, /setTimeout\(\(\) => \{[\s\S]*endIntentionalSleep\(\);[\s\S]*\}, SLEEP_RECONNECT_GUARD_MS\)/,
  'the reconnect preference is restored only after the intentional disconnect has settled');
assert.match(source, /attributeFilter:\['data-device-state','data-state'\]/);
assert.match(source, /synap-gatt-service-ready/);

console.log('PASS: one-recording invariant, hardware journal adoption and intentional-sleep reconnect guard.');
