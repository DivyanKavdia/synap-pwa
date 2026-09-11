'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('production PWA contract matches firmware transport and lifecycle', () => {
  const app = read('app.js');
  const codec = read('audio-codec-v3.js');
  const events = read('event-channel.js');
  const bridge = read('recording-bridge.js');
  const sleepGuard = read('sleep-state-guard.js');
  const sw = read('sw.js');
  const html = read('index.html');
  const theme = read('theme.js');
  const dashboard = read('dashboard-ui.js');
  const ask = read('ask-synap.js');
  const compat = read('runtime-compat.js');
  const enhancements = read('enhancements.js');

  assert.match(app, /MIN_CHUNKS_PER_FRAME = 1/);
  assert.match(app, /MIN_STREAM_MTU = 32/);
  assert.doesNotMatch(app, /receivedStatus\.mtu < 91/);
  assert.match(app, /SynapAudioCodecV3\?\.normalizePacket/);
  assert.match(codec, /ADPCM_BYTES_PER_FRAME=404/);
  assert.doesNotMatch(codec, /EventTarget|BluetoothRemoteGATTCharacteristic|patchService|patchCharacteristic/);

  assert.match(app, /AUDIO_STALL_TIMEOUT_MS = 12000/);
  assert.match(app, /FOREGROUND_STALL_GRACE_MS = 12000/);
  assert.match(app, /document\.visibilityState === "visible"/);
  assert.match(app, /Foreground pendant status resynchronised/);
  assert.match(app, /function validHttpsEndpoint/);

  assert.match(html, /<strong>Double tap<\/strong>Record on \/ off/);
  assert.match(html, /<strong>Triple tap<\/strong>Sleep \/ wake/);
  assert.doesNotMatch(bridge, /hold 2s to start|hold ~1s|deliberate tap to stop|hold to remember|hold 5s to sleep/);
  assert.match(sleepGuard, /synap-intentional-sleep-v1/);
  assert.match(sleepGuard, /forceReconnectOff\(\)/);
  assert.match(sleepGuard, /synap-gatt-service-ready/);

  assert.doesNotMatch(events, /script\.src=['"]audio-codec-v3/);
  assert.match(sw, /1\.0\.0-shell49-actions/);
  assert.match(sw, /1\.0\.0-actions1/);
  assert.match(sw, /\.\/dashboard-ui\.js/);
  assert.match(sw, /\.\/ask-synap\.js/);
  assert.match(sw, /\.\/sleep-state-guard\.js/);
  assert.match(sw, /\.\/runtime-compat\.js/);
  assert.match(sw, /\.\/processing-recovery\.js/);
  assert.match(html, /dashboard-ui\.js\?v=1\.0\.0-actions1/);
  assert.match(sw, /\.\/my-actions\.js/);
  assert.match(html, /my-actions\.js\?v=1\.0\.0-actions1/);
  assert.match(html, /ask-synap\.js\?v=1\.0\.0-workflows1/);
  assert.match(html, /sleep-state-guard\.js\?v=/);
  assert.match(html, /recording-bridge\.js\?v=/);
  assert.match(ask, /SynapAuth\.authedFetch\(ASK_ENDPOINT/);
  assert.match(ask, /const ASK_ENDPOINT = '\/v1\/ask'/);

  // UI architecture: all product surfaces stay mounted. The dashboard only
  // navigates to them; it never collapses/reparents or display:none's the app.
  assert.match(dashboard, /capture:'#capture'/);
  assert.match(dashboard, /scrollIntoView/);
  assert.match(dashboard, /IntersectionObserver/);
  assert.match(dashboard, /overflow-x:clip/);
  assert.doesNotMatch(dashboard, /function wrapActions|function wrapConversations/);
  assert.doesNotMatch(dashboard, /data-synap-view="today"[^\n]*display:none/);

  assert(html.indexOf('runtime-compat.js') < html.indexOf('app.js'), 'runtime compatibility must load before app initialization');
  assert.match(compat, /settingsButton\.addEventListener\('click'/);
  assert.match(compat, /if \(dialog\.open\) return/);
  assert.match(enhancements, /e\.data\.shellRevision===SHELL_REVISION/);
});
