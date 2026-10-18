'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('C3 SD delete only acknowledges fresh catalogue-verified removal',()=>{
  const preview=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
  const library=fs.readFileSync('devices/chakshu/library.js','utf8');
  const method=preview.split('async function deleteSDItem(path) {')[1]
    .split('async function discardIncompleteSD(path) {')[0];
  assert.match(method,/!api\(\)\.state\.storageReady/);
  assert.match(method,/await deleteSyncedSet\(path\)/);
  assert.match(method,/fresh = await api\(\)\.catalogue\(\)/);
  assert.match(method,/fresh\.some\(\(file\) => file\.path === path\)/);
  assert(method.indexOf('fresh.some')<method.indexOf('localStorage.removeItem'),
    'receipt must only be cleared after verified deletion');
  assert.match(method,/delete-unverified/);
  assert.match(method,/delete-verified/);
  const incomplete=preview.split('async function discardIncompleteSD(path) {')[1]
    .split('async function describeVisual(')[0];
  assert.match(incomplete,/await deleteSDItem\(path\)/);
  assert.match(library,/discard\.disabled = !sdReady \|\| c3DeletePaused/);
  assert.match(library,/SD access paused · Original recordings preserved · Do not format or delete/);
});
