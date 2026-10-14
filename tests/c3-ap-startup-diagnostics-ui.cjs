'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const preview=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const transfer=fs.readFileSync('devices/chakshu/transfer.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const sw=fs.readFileSync('sw.js','utf8');

test('Wi-Fi hotspot failure inspection uses only BLE op21 and never mutates SD',()=>{
 const handler=preview.split("document.getElementById('diagnoseDeviceAp')?.addEventListener('click'")[1]
   .split('root.setTimeout(async()=>')[0];
 assert(handler);
 assert.match(handler,/await c3ApStatus\(\)/);
 assert.match(handler,/Number\(ap\?\.failure\)/);
 assert.match(handler,/Number\(ap\?\.freeHeap\)/);
 assert.match(handler,/Number\(ap\?\.largestBlock\)/);
 assert.match(handler,/No SD data was changed/);
 assert.doesNotMatch(handler,/startC3Ap\(|formatSD\(|deleteSD\(|clearSD\(|recoverSd\(/);
 const read=transfer.split('_c3ApStatus(signal) {')[1].split('c3ApStatus(signal)')[0];
 assert.match(read,/this\._request\(21, 0, '', signal\)/);
 assert.match(preview,/id="diagnoseDeviceAp"/);
});
test('shell208 SW and HTML load the new cached C3 AP diagnostic script',()=>{
 assert.match(sw,/CACHE_REVISION='1\.0\.0-shell208-c3-ap-ssid-diagnostics'/);
 assert.match(html,/app\.js\?v=1\.0\.0-shell208-c3-ap-ssid-diagnostics/);
 assert.match(html,/capture-preview\.js\?v=1\.0\.0-c3-ap-ssid-diagnostics/);
});
