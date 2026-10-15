'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const app=fs.readFileSync('app.js','utf8');
const preview=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const transfer=fs.readFileSync('devices/chakshu/transfer.js','utf8');

test('Retired C3 Wi-Fi handoff never vetoes automatic BLE reconnect',()=>{
 const gate=app.split('function c3PrivateWifiHandoffActive() {')[1]
  .split('function reconnectRequested()')[0];
 assert.match(gate,/return false;/);
 assert.doesNotMatch(gate,/SynapChakshuV2\?\.isC3ApHandoffActive/);
 assert.match(preview,/isC3ApHandoffActive: \(\) => false/);
 const monitor=app.split('function monitorAllowed() {')[1]
  .split('function watchRememberedAdvertisements()')[0];
 assert.match(monitor,/reconnectRequested\(\)/);
});
test('C3 hotspot controls are absent but read-only SD transfer and fallback remain available',()=>{
 assert.doesNotMatch(preview,/id="startDeviceAp"|id="stopDeviceAp"|id="diagnoseDeviceAp"/);
 assert.match(preview,/supportsC3Wifi = false/);
 assert.match(preview,/Syncing to Memories over Bluetooth/);
 assert.match(transfer,/this\.sendOnly\(fast \? 30 : 12/);
 assert.match(transfer,/this\.streamDisabled = true/);
});
