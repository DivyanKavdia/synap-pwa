'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const preview=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const transfer=fs.readFileSync('devices/chakshu/transfer.js','utf8');
test('Odyssey C3 no longer exposes hotspot or Wi-Fi Settings buttons',()=>{
  assert.doesNotMatch(preview,/id="startDeviceAp"|id="stopDeviceAp"|id="diagnoseDeviceAp"/);
  assert.match(preview,/supportsC3Wifi = false/);
  assert.match(preview,/Odyssey C3 is BLE-only/);
});
test('Odyssey C3 BLE SD file windows are explicit path and bounded',()=>{
  assert.match(transfer,/const fast = \(op === 30 && Boolean\(path\)\) \|\| adaptive/);
  assert.match(transfer,/Math\.max\(6, Math\.min\(12, credits\)\)/);
  assert.match(transfer,/this\.sendOnly\(compressed \? 36 : fast \? \(adaptive \? 31 : 30\) : 12/);
});
