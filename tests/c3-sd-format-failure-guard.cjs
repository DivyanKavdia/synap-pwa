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
  assert.match(page,/capture-preview\.js\?v=1\.0\.0-c3-[a-z0-9-]+/);
});

test('C3 full-card on-device format is disabled in the UI and before op19',()=>{
  assert.match(s,/const C3_FULL_CARD_FORMAT_DISABLED = true/);
  const guard=format.indexOf('if (C3_FULL_CARD_FORMAT_DISABLED)');
  const command=format.indexOf('client().request(19)');
  assert(guard>=0 && command>guard,'safety gate must run before destructive command');
  assert.match(format,/Odyssey C3 on-device full-card formatting is temporarily disabled/);
  assert.match(s,/formatSettings\.disabled =[\s\S]*?C3_FULL_CARD_FORMAT_DISABLED/);
  assert.match(s,/Format SD \(disabled\)/);
  assert.match(s,/Power off and format on a computer/);
});

test('C3 blocks all BLE FAT maintenance writes before op17, op18 or op19',()=>{
  assert.match(s,/const C3_SD_MAINTENANCE_WRITES_DISABLED = true/);
  assert.match(s,/function c3MaintenanceWritesBlocked\(\)/);
  const deleteCommand=s.split('async function deleteSD(path, optional = false) {')[1].split('async function deleteSyncedSet(')[0];
  const deleteItem=s.split('async function deleteSDItem(path) {')[1].split('async function discardIncompleteSD(')[0];
  const clear=s.split('async function clearSD() {')[1].split('async function diagnoseC3SdReadOnly(')[0];
  for(const [name,body,command] of [
    ['delete',deleteCommand,'client().request(17'],
    ['delete item',deleteItem,'deleteSyncedSet(path)'],
    ['clear',clear,'client().request(18'],
  ]){
    const guard=body.indexOf('if (c3MaintenanceWritesBlocked())');
    assert(guard>=0 && guard<body.indexOf(command),name+' must gate FAT mutation');
  }
  assert.match(s,/remove.disabled = c3MaintenanceWritesBlocked\(\)/);
  assert.match(s,/clear.disabled = c3MaintenanceWritesBlocked\(\)/);
  assert.match(s,/clearSettings.disabled =[\s\S]*?c3MaintenanceWritesBlocked\(\)/);
  assert.match(s,/Synced recordings remain on SD/);
  // Keep reads / recording unchanged: this is only a PWA maintenance guard.
  assert.match(s,/await reportC3PostSync\(path, connection\)/);
});
