'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const transfer=fs.readFileSync('devices/chakshu/transfer.js','utf8');
const capture=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const html=fs.readFileSync('index.html','utf8');
test('C3 format is explicitly confirmed and capability-gated',()=>{
  assert.match(capture,/mediaFeatures & 4/);
  assert.match(capture,/await client\(\)\.request\(19\)/);
  assert.match(capture,/ALL files on the card will be permanently erased/);
  assert.match(capture,/info\?\.sdDetectionState !== 1 \|\| info\?\.sdLiveProbeState !== 6/);
});
test('format waits for slow native FAT and warns on uncertain timeout; no automatic replay',()=>{
  assert.match(transfer,/C3_SD_FORMAT_DEADLINE_MS = 600000/);
  assert.match(transfer,/op === 19 \? C3_SD_FORMAT_DEADLINE_MS : RESPONSE_DEADLINE_MS/);
  assert.match(transfer,/do not immediately repeat Format/);
  assert.match(html,/devices\/chakshu\/transfer\.js\?v=1\.0\.0-c3-sd-format-2042/);
});
