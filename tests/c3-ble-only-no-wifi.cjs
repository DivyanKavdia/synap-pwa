'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
test('Odyssey C3 operates with BLE-only SD transfer while retaining Chakshu-specific Wi-Fi',()=>{
 const preview=read('devices/chakshu/capture-preview.js');
 const media=read('devices/chakshu/media.js');
 const library=read('devices/chakshu/library.js');
 const transfer=read('devices/chakshu/transfer.js');
 const app=read('app.js');
 assert.doesNotMatch(preview,/startC3Ap|stopC3Ap|c3ApStatus|c3WifiStatus|moveC3Wifi|c3BridgeAp|deviceWifiSettings/);
 assert.doesNotMatch(transfer,/startC3Ap|stopC3Ap|configureC3Wifi|_sendC3Config|c3WifiStatus/);
 assert.doesNotMatch(library,/library-sd-wifi|startC3Ap/);
 assert.doesNotMatch(app,/c3PrivateWifiHandoffActive|privateWifiHandoff/);
 assert.match(transfer,/async window\(offset, total, signal, path = ''\)/);
 assert.match(transfer,/this\.sendOnly\(12, offset, signal, id, path\)/);
 assert.match(transfer,/const readOp = image \? 2 : 4/);
 assert.match(preview,/C3_SD_MAINTENANCE_WRITES_DISABLED = true/);
 assert.match(media,/moduleInfo\(\)\?\.id === 3 \? moduleInfo\(\)\?\.mediaFeatures & 4 : false/);
});
