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
  const sw = read('sw.js');
  const html = read('index.html');
  const compat = read('runtime-compat.js');
  const enhancements = read('enhancements.js');

  assert.match(app, /MIN_CHUNKS_PER_FRAME = 1/);
  assert.match(app, /MIN_STREAM_MTU = 32/);
  assert.doesNotMatch(app, /receivedStatus\.mtu < 91/);
  assert.match(app, /SynapAudioCodecV3\?\.normalizePacket/);
  assert.match(codec, /ADPCM_BYTES_PER_FRAME=404/);
  assert.doesNotMatch(codec, /EventTarget|BluetoothRemoteGATTCharacteristic|patchService|patchCharacteristic/);

  assert.match(app, /AUDIO_STALL_TIMEOUT_MS = 12000/);
  assert.match(app, /FOREGROUND_STALL_GRACE_MS = 3000/);
  assert.match(app, /document\.visibilityState === "visible"/);
  assert.match(app, /Foreground pendant status resynchronised/);
  assert.match(app, /function validHttpsEndpoint/);

  assert.match(bridge, /Touch: double tap to start\/stop · hold 5s to sleep · triple tap to wake/);
  assert.doesNotMatch(bridge, /hold 2s to start|hold ~1s|deliberate tap to stop|hold to remember|hold 5s to sleep\/wake/);

  assert.doesNotMatch(events, /script\.src=['"]audio-codec-v3/);
  assert.match(sw, /1\.0\.0-shell30-processing-recovery/);
  assert.match(sw, /\.\/runtime-compat\.js/);
  assert.match(sw, /\.\/processing-recovery\.js/);
  assert(html.indexOf('runtime-compat.js') < html.indexOf('app.js'), 'runtime compatibility must load before app initialization');
  assert.match(compat, /settingsButton\.addEventListener\('click'/);
  assert.match(compat, /if \(dialog\.open\) return/);
  assert.match(enhancements, /e\.data\.shellRevision===SHELL_REVISION/);
});
