'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const tx=fs.readFileSync('devices/chakshu/transfer.js','utf8');
const preview=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const library=fs.readFileSync('devices/chakshu/library.js','utf8');
test('C3 user-facing transfer stays BLE-only without a SoftAP handoff',()=>{
 assert.doesNotMatch(preview,/id="startDeviceAp"|id="stopDeviceAp"/);
 assert.doesNotMatch(library,/Start Wi-Fi downloads|Start private Wi-Fi downloads/);
 assert.match(preview,/Syncing to Memories over Bluetooth/);
});
test('fast C3 media windows keep bounded credits and legacy op12 fallback',()=>{
 assert.match(tx,/this\.sendOnly\(fast \? \(adaptive \? 31 : 30\) : 12/);
 assert.match(tx,/const prefix = compact \? 16 : adaptive \? 12 : fast \? 11 : 10/);
 assert.match(tx,/new MediaWindow\(id, offset, total, fast \? 12 : 8, Boolean\(path\)\)/);
 assert.match(tx,/this\.streamDisabled = true/);
});
