'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const s=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const page=fs.readFileSync('index.html','utf8');
const format=s.split('async function formatSD() {')[1].split('async function startOffline(')[0];
const render=s.split('function renderSDInbox(')[1]?.split('async function syncAll(')[0]||s;

test('C3 unsafe historical write fault blocks destructive formatting',()=>{
  assert.match(s,/function c3FormatUnsafe\(\)/);
  assert.match(s,/Number\(info\?\.sdProbeState\) >= 40/);
  assert.match(format,/if \(c3FormatUnsafe\(\)\)/);
  assert.match(s,/formatSettings\.disabled =[\s\S]*?c3FormatUnsafe\(\)/);
  assert.match(format,/!api\(\)\.state\.storageReady/);
});

test('failed format captures only read-only op27 and does not auto-remount',()=>{
  assert.match(format,/client\(\)\.request\(19\)/);
  assert.match(format,/client\(\)\.request\(27\)/);
  assert.match(format,/format-failed-media-snapshot/);
  assert.match(format,/historicRecordStage/);
  assert.doesNotMatch(format,/api\(\)\.refreshSD\(\)|request\(14\)|request\(18\)/);
  assert.equal((format.match(/client\(\)\.request\(19\)/g)||[]).length,1);
});

test('successful format settles, then observes catalogue before deleting receipts',()=>{
  assert.match(format,/await new Promise\(\(resolve\) => root\.setTimeout\(resolve, 6000\)\)/);
  assert.match(format,/const files = await api\(\)\.catalogue\(\)/);
  assert.match(format,/files\.length !== 0/);
  assert(format.indexOf('const files = await api().catalogue()') <
    format.indexOf('localStorage.removeItem'));
  assert.match(page,/capture-preview\.js\?v=1\.0\.0-c3-sd-raw-diagnostic2063/);
});
