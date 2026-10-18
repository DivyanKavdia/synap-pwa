'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const src=fs.readFileSync('devices/chakshu/library.js','utf8');
const body=src.split('function updateCard(card, row) {')[1].split('function ')[0];

test('Library distinguishes BLE disconnect from genuine unready SD mount',()=>{
  assert.match(body,/pendantConnected = Boolean\(api\(\)\.state\.connected\)/);
  assert.match(body,/sdMounted = Boolean\(api\(\)\.state\.storageReady\)/);
  assert.match(body,/sdReady = pendantConnected && sdMounted/);
  assert.match(body,/preview\.textContent = !pendantConnected\s*\? 'Pendant disconnected · SD status unknown/);
  assert.match(body,/: !sdMounted\s*\? 'SD access paused · Original recordings preserved/);
  const disconnected=body.indexOf("preview.textContent = !pendantConnected");
  const sdFault=body.indexOf("SD access paused · Original recordings preserved");
  assert(disconnected>=0&&disconnected<sdFault);
});

test('disconnected or SD-paused Library blocks delete; retained sync receipts still shown',()=>{
  assert.match(body,/discard\.disabled = !sdReady/);
  assert.match(body,/discard\.title = sdReady \? '' : !pendantConnected/);
  assert.match(body,/Synced to Memories · Also on device SD/);
  assert.doesNotMatch(body,/\b(?:unlink|format|deleteSDItem|removeFile)\s*\(/);
});
