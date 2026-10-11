'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const catalog=require('../devices/catalog.json');

test('PWA device catalogue retains the authoritative Odyssey C3 hardware pin contract',()=>{
  assert.equal(catalog.schema,1);
  const c3=catalog.devices.find(device=>device.id==='esp32c3-supermini-4m');
  assert.ok(c3,'already shipped no-SD C3 keeps its exact existing firmware identity');
  assert.equal(c3.moduleId,2);
  assert.deepEqual(c3.hardware.sdDetection,{cs:0,sck:10,mosi:21,miso:20});
  assert.deepEqual(
    {bclk:c3.hardware.bclk,ws:c3.hardware.ws,data:c3.hardware.data,touch:c3.hardware.touch,
      led:c3.hardware.led,battery:c3.hardware.battery},
    {bclk:4,ws:5,data:6,touch:3,led:8,battery:1}
  );
  const pins=[...Object.values(c3.hardware.sdDetection),
    c3.hardware.bclk,c3.hardware.ws,c3.hardware.data,c3.hardware.touch,
    c3.hardware.led,c3.hardware.battery];
  assert.equal(new Set(pins).size,pins.length,'C3 SD SPI must not reuse microphone, touch, LED or battery pins');
  assert.ok(c3.features.includes('sdAudio'));
  assert.equal(c3.protocols.media,1,'existing SD chunk protocol must stay compatible');
});

test('the PWA mirrors optional S3 SD detection without enabling S3 offline SD recording',()=>{
  const s3=catalog.devices.find(device=>device.id==='esp32s3-fh4r2-qspi-4m');
  assert.ok(s3);
  assert.deepEqual(s3.hardware.sdDetection,{cs:9,sck:12,mosi:10,miso:11});
  assert.ok(!s3.features.includes('sdAudio'),'S3 remains detection-only');
});


test('new C3+SD has isolated larger-OTA identity and preserves BLE media module protocol',()=>{
  const newUnit=catalog.devices.find(d=>d.id==='esp32c3-supermini-4m-sd');
  const old=catalog.devices.find(d=>d.id==='esp32c3-supermini-4m');
  assert(newUnit);
  assert.equal(old.partition,'default');
  assert.equal(old.slotSize,1310720);
  assert.equal(old.productMarker,'SYNAP-ESP32C3-OTA-ID-V3');
  assert.equal(newUnit.partition,'c3-sd-dual-ota');
  assert.equal(newUnit.slotSize,1966080);
  assert.equal(newUnit.productMarker,'SYNAP-ESP32C3-SD-OTA-ID-V1');
  assert.notEqual(newUnit.manifestPath,old.manifestPath);
  assert.equal(newUnit.moduleId,2,'PWA SD/BLE media behavior stays on module 2');
  assert.deepEqual(newUnit.hardware.sdDetection,old.hardware.sdDetection);
  assert.equal(newUnit.protocols.media,1);
  const profiles=require('../devices/profiles.js');
  assert.equal(profiles.BY_TARGET[newUnit.id].maxSize,1966080);
  assert.equal(profiles.BY_MODULE[2].target,old.id,'legacy module display stays stable');
});
