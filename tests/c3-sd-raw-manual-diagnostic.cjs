'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const pwa=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const handler=pwa.split("document.getElementById('diagnoseDeviceSD')?.addEventListener('click', async () => {")[1]
  .split("document.getElementById('clearDeviceSD')")[0];
test('raw SD diagnostic is opt-in and shown only for unavailable Odyssey C3',()=>{
  assert.match(pwa,/id="diagnoseDeviceSD" type="button" hidden/);
  assert.match(pwa,/rawDiagnosticSettings.hidden = info\?\.id !== 2/);
  assert.match(pwa,/blocked \|\| !state.connected \|\| state.storageReady/);
  assert.match(handler,/api\(\)\?\.state\?\.storageReady\) return/);
  assert.match(handler,/await client\(\)\.request\(28\)/);
  assert.match(handler,/sd-raw-read-only-diagnostic/);
  assert.match(handler,/firstMountErr/);
});
test('PWA never triggers destructive SD operations as part of forensic read',()=>{
  assert.doesNotMatch(handler,/request\(14\)|request\(17\)|request\(18\)|request\(19\)|refreshSD\(|formatSD\(|clearSD\(|deleteSDItem\(/);
  assert.match(handler,/error\?\.mediaCode === 2/);
  assert.match(html,/capture-preview\.js\?v=1\.0\.0-c3-sd-raw-diagnostic2063/);
});
