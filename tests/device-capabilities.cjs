'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
const profiles = require('../devices/profiles.js');
const caps = require('../devices/capabilities.js');
const { decode } = require('../devices/modules.js');
const ota = require('../ota.js'),
  releases = require('../releases.js');
const { generate } = require('../tools/device-catalog.cjs');
const mask = (features) => features.reduce((sum, key) => sum | profiles.FLAGS[key], 0);
function descriptor(id, supported, ready, media = 1, voice = 1) {
  const v = new DataView(new ArrayBuffer(20));
  [0xc7, 1, id, 1].forEach((n, i) => v.setUint8(i, n));
  v.setUint16(4, supported, true);
  v.setUint16(6, ready, true);
  v.setUint16(10, 16000, true);
  v.setUint8(14, media);
  v.setUint8(15, voice);
  return decode(v);
}
test('OTA, release selection and module discovery share the generated catalog', () => {
  assert.equal(
    fs.readFileSync('devices/profiles.js', 'utf8'),
    generate(JSON.parse(fs.readFileSync('devices/catalog.json', 'utf8'))),
  );
  for (const p of Object.values(profiles.BY_MODULE)) {
    assert.equal(ota.IMAGE_TARGETS[p.target], p);
    assert.equal(
      releases.targetFromIdentity(`SYNAP-FW:${p.target}:synap-os1-build1229:1229`).target,
      p.target,
    );
    const info = descriptor(p.id, mask(p.features), 0);
    assert.equal(info.target, p.target);
    assert.equal(info.name, p.name);
  }
});
test('a protocol version or spoofed extra flags never gives C3/S3 Chakshu functions', () => {
  for (const id of [1, 2]) {
    const info = descriptor(id, 1023, 1023);
    assert.equal(caps.supports(info, 'audio'), true);
    assert.equal(caps.supports(info, 'camera'), false);
    assert.equal(caps.canCapture(info, 'photo'), false);
    assert.equal(caps.hasMedia(info), false);
    assert.equal(caps.hasVoice(info), false);
    assert.equal(caps.hardwareCheck(info, 1), false);
  }
  const wrong = { ...descriptor(3, 911, 911), target: profiles.BY_MODULE[1].target };
  assert.equal(caps.isChakshu(wrong), false);
});
test('Chakshu live capture needs a ready camera, and offline video additionally needs SD', () => {
  const all = mask(profiles.BY_MODULE[3].features);
  const noSD = descriptor(3, all, all & ~(profiles.FLAGS.sd | profiles.FLAGS.sdAudio));
  assert.equal(caps.canCapture(noSD, 'photo'), true);
  assert.equal(caps.canCapture(noSD, 'video'), true);
  assert.equal(caps.canCapture(noSD, 'video', true), false);
  assert.equal(caps.hasVoice(noSD), false, 'retired voice stays off even on older firmware');
  assert.equal(caps.hardwareCheck(noSD, 1, true), true, 'hardware refresh stays available');
  assert.equal(caps.hardwareCheck(noSD, 3, true), false);
  const noMic = descriptor(3, all, all & ~(profiles.FLAGS.audio | profiles.FLAGS.sdAudio));
  assert.equal(caps.canCapture(noMic, 'photo'), true);
  assert.equal(caps.canCapture(noMic, 'video'), false, 'paired video requires a microphone');
  assert.equal(caps.canCapture(noMic, 'video', true), false);
  assert.equal(caps.canCapture(descriptor(3, all, 0), 'photo'), false);
  assert.equal(caps.canCapture(descriptor(3, all, all, 0), 'photo'), false);
  assert.equal(caps.hasVoice(descriptor(3, all, all, 1, 0)), false);
  assert.equal(caps.canCapture({ ...noSD, legacy: true }, 'photo'), false);
  assert.equal(caps.canCapture(null, 'photo'), false);
});

test('camera gating distinguishes detecting, failed, other hardware and stale connections', () => {
  const connection = { deviceId: 'SYNAP-68EE8F4719A0' };
  const client = { context: connection, module: null };
  assert.equal(caps.cameraConnection(null, client).state, 'disconnected');
  assert.equal(caps.cameraConnection(connection, client).state, 'detecting');
  client.error = 'Read failed';
  assert.equal(caps.cameraConnection(connection, client).state, 'unavailable');
  for (const id of [1, 2]) {
    client.module = descriptor(id, 1023, 1023);
    const state = caps.cameraConnection(connection, client);
    assert.equal(state.state, 'unsupported');assert.match(state.message, /is connected/);
  }
  client.module = descriptor(3, 911, 911);
  assert.equal(caps.cameraConnection(connection, client).state, 'connected');
  assert.equal(caps.cameraConnection({ ...connection }, client).state, 'detecting', 'old descriptor cannot unlock another physical link');
  delete connection.deviceId;
  assert.equal(caps.cameraConnection(connection, client).state, 'unavailable');
});
