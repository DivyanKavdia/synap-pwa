'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const code=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const page=fs.readFileSync('index.html','utf8');
const method=code.split('async function deleteSDItem(path) {')[1]
  .split('async function discardIncompleteSD(path) {')[0];

test('C3 keeps an idle settle between user-authorized unlink and FAT catalogue',()=>{
  assert.match(method,/await deleteSyncedSet\(path\)/);
  assert.match(method,/const isC3 = root\.SynapModules\?\.client\?\.module\?\.id === 2/);
  assert.match(method,/const settleMs = 6000/);
  assert.match(method,/await new Promise\(\(resolve\) => root\.setTimeout\(resolve, settleMs\)\)/);
  assert(method.indexOf('await deleteSyncedSet(path)')<
    method.indexOf('await new Promise') &&
    method.indexOf('await new Promise')<method.indexOf('fresh = await api().catalogue()'));
  assert.equal((method.match(/await deleteSyncedSet\(path\)/g)||[]).length,1,
    'never repeat a destructive unlink');
  assert.doesNotMatch(method,/request\(14\)|request\(19\)/);
});

test('uncertain deletion retains receipt and reads only SD-independent diagnostics',()=>{
  assert.match(method,/fresh\.some\(\(file\) => file\.path === path\)/);
  assert(method.indexOf('fresh.some')<method.indexOf('localStorage.removeItem'));
  assert.match(method,/client\(\)\.request\(27\)/);
  assert.match(method,/delete-unverified-media-snapshot/);
  assert.match(method,/historicRecordStage/);
  assert.match(method,/delete-command-failed/);
  assert.match(method,/delete-unverified/);
  assert.match(page,/devices\/chakshu\/capture-preview\.js\?v=1\.0\.0-c3-sd-delete-linkguard2063/);
});

test('verified SD receipt survives BLE reconnection or account change during settle and catalogue',()=>{
  const guard = method.split('const assertSameConnection = () => {')[1].split('};')[0];
  assert.match(guard,/root\.SynapDevices\?\.connection !== connection/);
  assert.match(guard,/api\(\)\?\.state\?\.owner !== originalOwner/);
  assert.match(guard,/delete-unverified-link-changed/);
  assert.equal((method.match(/assertSameConnection\(\)/g)||[]).length,2);
  assert(method.indexOf('await new Promise')<method.indexOf('assertSameConnection()'));
  assert(method.lastIndexOf('assertSameConnection()')<method.indexOf('localStorage.removeItem'));
});
