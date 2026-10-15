'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const preview=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const transfer=fs.readFileSync('devices/chakshu/transfer.js','utf8');
const modules=fs.readFileSync('devices/modules.js','utf8');
test('Odyssey C3 no longer displays private hotspot diagnostic controls',()=>{
 assert.doesNotMatch(preview,/id="diagnoseDeviceAp"|id="startDeviceAp"|id="stopDeviceAp"/);
 assert.match(preview,/supportsC3Wifi = false/);
});
test('fast BLE transfer remains bounded with user-visible progress and failure recovery',()=>{
 assert.match(modules,/value\.getUint8\(16\) & 0x45/);
 assert.match(transfer,/this\.fastCredits = Math\.max\(6/);
 assert.match(transfer,/this\.fastCredits = Math\.min\(12/);
 assert.match(transfer,/if \(this\.features & 1 && !this\.streamDisabled\)/);
});
