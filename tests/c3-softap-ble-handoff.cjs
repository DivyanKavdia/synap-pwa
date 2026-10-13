'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const tx=fs.readFileSync('devices/chakshu/transfer.js','utf8');
const preview=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const app=fs.readFileSync('app.js','utf8');
test('SoftAP startup does not depend on post-Wi-Fi Bluetooth op21',()=>{
 const fn=tx.split('    startC3Ap(signal) {')[1].split('    stopC3Ap(signal) {')[0];
 assert.match(fn,/const started=await this\._request\(20/);
 assert.match(fn,/JSON\.parse\(new TextDecoder\(\)\.decode\(started\.bytes\)\)/);
 assert.match(fn,/if\(next\?\.active\)/);
 assert.match(fn,/return next/);
 assert(fn.indexOf('if(next?.active)')<fn.indexOf('try { next=await this._c3ApStatus(signal); }'));
});
test('Wi-Fi credentials remain usable after BLE disconnect, including Library-initiated start',()=>{
 const fn=preview.split('  function showC3ApInfo(next, trustedIdentity=null) {')[1]
  .split('  // Verified same-window-family bridge')[0];
 assert(fn.indexOf('c3BridgeAp=next')<fn.indexOf('if(!node || !link)return'));
 assert.match(preview,/supportsC3Wifi = Boolean\(\(info\?\.id === 2/);
 assert.match(preview,/c3BridgeAp\?\.active\)/);
 assert.match(preview,/isC3ApHandoffActive: \(\) => Boolean\(c3BridgeAp\?\.active\)/);
 assert.match(preview,/Bluetooth may disconnect/);
});
test('GATT disconnect due to active AP does not schedule recursive BLE retries',()=>{
 const fn=app.split('async function handleGattDisconnected(event) {')[1]
  .split('function cleanupCharacteristics() {')[0];
 assert.match(fn,/const privateWifiHandoff=Boolean/);
 assert.match(fn,/isC3ApHandoffActive\?\.\(\)/);
 assert.match(fn,/if \(!manualDisconnect && !privateWifiHandoff\)/);
});
