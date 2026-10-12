'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const profiles = require('../devices/profiles.js');
const ota = require('../ota.js');
const releases = require('../releases.js');
const catalog = require('../devices/catalog.json');

const LEGACY = 'esp32c3-supermini-4m';
const SD = 'esp32c3-supermini-4m-sd';

function fakeImage(target) {
  const config = ota.IMAGE_TARGETS[target];
  const image = new Uint8Array(512);
  image[0] = 0xE9;
  new DataView(image.buffer).setUint16(12, 5, true);
  new DataView(image.buffer).setUint32(32, 0xABCD5432, true);
  image.set(new TextEncoder().encode(config.marker), 64);
  return image;
}

test('factory C3+SD uses a distinct OTA target while sharing BLE module 2', () => {
  const legacy = profiles.BY_TARGET[LEGACY], sd = profiles.BY_TARGET[SD];
  assert.ok(legacy && sd);
  assert.equal(legacy.id, 2);
  assert.equal(sd.id, 2);
  assert.equal(profiles.BY_MODULE[2].target, LEGACY, 'do not change shipped C3 module resolution');
  assert.equal(legacy.maxSize, 1310720);
  assert.equal(sd.maxSize, 1966080);
  assert.equal(sd.partition, 'c3-sd-dual-ota');
  assert.notEqual(legacy.marker, sd.marker);
  assert.notEqual(legacy.manifestPath, sd.manifestPath);
  assert.equal(catalog.devices.filter(device => device.id === SD).length, 1);
});

test('OTA validation never crosses factory SD and shipped C3 firmware identities', () => {
  assert.equal(ota.validateImage(fakeImage(SD), 1966080, 3, SD), SD);
  assert.equal(ota.validateImage(fakeImage(LEGACY), 1310720, 3, LEGACY), LEGACY);
  assert.throws(() => ota.validateImage(fakeImage(SD), 1966080, 3, LEGACY), /selected synap hardware target/);
  assert.throws(() => ota.validateImage(fakeImage(LEGACY), 1966080, 3, SD), /selected synap hardware target/);
  assert.equal(ota.transferPlan(SD, 503).windowChunks, ota.transferPlan(LEGACY, 503).windowChunks);
});

test('firmware identities route release manifests to the correct C3 hardware generation', () => {
  const make = target => 'SYNAP-FW:' + target + ':synap-os1-build2119:2119';
  assert.equal(releases.targetFromIdentity(make(SD)).target, SD);
  assert.equal(releases.targetFromIdentity(make(LEGACY)).target, LEGACY);
  const config = profiles.BY_TARGET[SD];
  const build = 2120, hash = 'a'.repeat(64);
  const manifest = {
    schema: 3, version: 'synap-os1-build2120', build,
    target: SD, protocol: 3, chip: config.chip, flashBytes: config.flashBytes,
    psramBytes: config.psramBytes, partition: config.partition, size: 1500000,
    sha256: hash, commit: 'b'.repeat(40),
    identity: 'SYNAP-FW:' + SD + ':synap-os1-build2120:2120',
    url: 'https://raw.githubusercontent.com/DivyanKavdia/synap-firmware/ota-releases/' +
      config.releasePrefix + 'builds/' + build + '-' + hash + '.bin',
    channel: 'production',
    provenance: {
      provider: 'github-actions', repository: 'DivyanKavdia/synap-firmware',
      workflow: '.github/workflows/firmware.yml',
    },
  };
  assert.equal(releases.validateManifest(manifest).target, SD);
  assert.throws(() => releases.validateManifest({...manifest, partition:'default'}), /Invalid or incompatible/);
});
