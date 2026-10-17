'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
test('C3 settings expose recover, guarded format and read-only FAT capacity',()=>{
 assert.match(ui,/id="retryDeviceSD" type="button">Recover SD/);
 assert.match(ui,/id="checkDeviceSDCapacity" type="button">Check capacity/);
 assert.match(ui,/id="deviceSDCapacity"/);
 assert.match(ui,/client\(\)\.request\(32\)/);
 assert.match(ui,/Number\.isSafeInteger\(value\)/);
 assert.match(ui,/Type FORMAT SD to confirm permanent erasure/);
 assert.match(ui,/await client\(\)\.request\(19, 0x5344464d\)/);
 assert.match(ui,/C3_SD_MAINTENANCE_WRITES_DISABLED = true/);
});
test('capacity read cannot format, clear or remount SD',()=>{
 const fn=ui.split('async function checkSDCapacity() {')[1].split('async function formatSD()')[0];
 assert.equal((fn.match(/client\(\)\.request\(32\)/g)||[]).length,1);
 assert.doesNotMatch(fn,/request\((?:17|18|19)\)|formatSD\(|clearSD\(|refreshSD\(/);
 assert.match(fn,/root\.SynapDevices\?\.connection !== connection/);
});