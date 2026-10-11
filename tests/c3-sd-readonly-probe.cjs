'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const code=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const fn=code.split('async function diagnoseC3SdReadOnly() {')[1].split('async function formatSD() {')[0];
test('read-only SD diagnostics must be explicit, available on C3 mount failure, and idle-only',()=>{
  assert.match(code,/id="diagnoseDeviceSD"/);
  assert.match(code,/getElementById\('diagnoseDeviceSD'\)\?\.addEventListener\('click'/);
  assert.match(code,/rawProbeSettings\.disabled =[\s\S]*?state\.storageReady/);
  assert.match(fn,/module\?\.id !== 2/);
  assert.match(fn,/api\(\)\.state\.storageReady/);
  assert.match(fn,/root\.SynapAppControls\?\.recordingState\?\.\(\)\.active/);
});
test('read-only diagnostic performs exactly one media op28 and no SD writes or remount',()=>{
  assert.equal((fn.match(/client\(\)\.request\(28\)/g)||[]).length,1);
  assert.doesNotMatch(fn,/request\((?:14|17|18|19)\)|refreshSD|clearSD|formatSD\(/);
  assert.match(fn,/raw-sector0-result/);
  assert.match(fn,/firstMountErr/);
  assert.match(fn,/\[1, 2\]\.includes\(data\.version\)/);
  assert.match(fn,/partitionBounds/);
  assert.match(fn,/bpbPlausible/);
  assert.match(fn,/vbrError/);
  assert.match(fn,/FAT tables and recordings remain unverified/);
  assert.match(fn,/error\?\.mediaCode === 2/);
  assert.match(fn,/root\.SynapDevices\?\.connection !== connection/);
  assert.match(html,/capture-preview\.js\?v=1\.0\.0-c3-sync-io-trace/);
});
