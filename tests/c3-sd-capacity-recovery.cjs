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
test('emergency SD format requires prior cold FAT-mount failure and exact typed authorization',()=>{
 assert.match(ui,/id="emergencyFormatDeviceSD"/);
 assert.match(ui,/Type ERASE SD to authorize/);
 assert.match(ui,/request\(33,0x53445246\)/);
 const body=ui.split('async function emergencyFormatSD() {')[1].split('async function formatSD()')[0];
 assert.match(body,/Number\(info\?\.sdLiveProbeState\)!==3/);
 assert.match(body,/info\?\.sdDetectionState!==2/);
 assert.match(body,/api\(\)\.state\.storageReady/);
 assert.match(body,/Never disconnect power/);
 assert.match(body,/Do not retry Format/);
 assert.doesNotMatch(body,/request\(19\)|request\(14\)|request\(18\)|localStorage\.removeItem/);
});

test('emergency reformat is denied for directory validation problems (stage4)',()=>{
 const run=ui.split('async function emergencyFormatSD() {')[1].split('async function formatSD()')[0];
 const button=ui.split('if (emergencySettings) {')[1].split('if (formatSettings) {')[0];
 assert.match(run,/Number\(info\?\.sdLiveProbeState\)!==3/);
 assert.match(button,/Number\(info\?\.sdLiveProbeState\)===3/);
 assert.doesNotMatch(run,/\[3,4\]/);
 assert.doesNotMatch(button,/\[3,4\]/);
});
