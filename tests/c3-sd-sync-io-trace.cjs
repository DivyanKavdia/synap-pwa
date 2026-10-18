'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const s=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const trace=s.split('async function reportC3SyncTrace(')[1].split('async function diagnoseC3SdWireReadOnly()')[0];
const move=s.split('async function moveSD(')[1].split('async function discardIncompleteSD(')[0];
const post=s.split('async function reportC3PostSync(')[1].split('async function syncAll(')[0];
test('post-sync diagnostic uses RAM-only op29 without any FAT command or retry',()=>{
  assert.match(trace,/client\(\)\.request\(29\)/);
  assert.equal((trace.match(/client\(\)\.request\(29\)/g)||[]).length,1);
  assert.doesNotMatch(trace,/request\((?:4|7|12|14|17|18|19)\)|catalogue\(|refreshSD|formatSD|deleteSD/);
  assert.match(trace,/c3-sync-read-trace/);
  for(const key of ['ioOp','ioStep','ioErr','diskFills','cacheHits',
    'lastRequestedOffset','lastOkOffset','faultOffset','mtuFallbacks','wireCmd','wireErr','wireArg','wireMs'])
    assert(trace.includes("'"+key+"'"),key);
  assert.match(trace,/return null;\s*\}\s*\}/);
});
test('recording/import receipt remains durable and trace is captured on both outcomes',()=>{
  assert(move.indexOf('localStorage.setItem(key, JSON.stringify(receipt))') <
    move.indexOf("await reportC3PostSync(path, connection)"));
  assert.match(move,/await reportC3SyncTrace\(path, connection, 'failed-' \+ stage\)/);
  assert.match(post,/reportC3SyncTrace\(path, connection, 'verified'\)/);
  assert.match(post,/trace\?\.sdState === 2/);
  assert.doesNotMatch(post,/request\((?:4|7|12|14|17|18|19)\)|catalogue\(/);
  assert.match(html,/capture-preview\.js\?v=1\.0\.0-c3-[a-z0-9-]+/);
});


test('standalone C3 RAM diagnosis can inspect native SDSPI failures even after FAT unmount',()=>{
  const block=s.split('async function diagnoseC3SdWireReadOnly() {')[1]
    .split('// Read-only post-sync diagnostics.')[0];
  assert.match(block,/client\(\)\.request\(29\)/);
  assert.equal((block.match(/client\(\)\.request\(29\)/g)||[]).length,1);
  assert.doesNotMatch(block,/request\((?:4|7|12|14|17|18|19|28)\)|catalogue\(|refreshSD|formatSD|deleteSD|unlink\(|readValue\(/);
  for(const field of ['sdState','sdLiveProbe','ioOp','ioStep','ioErr',
    'wireCmd','wireErr','wireArg','wireMs'])
    assert(block.includes("'"+field+"'"),field);
  assert.match(block,/4294967295/);
  assert.match(block,/c3-controller-ram-snapshot/);
  assert.match(s,/id="diagnoseDeviceSDRam"/);
  assert.match(s,/ramProbeSettings\.hidden = info\?\.id !== 2/);
  assert.match(s,/ramProbeSettings\.disabled = info\?\.id !== 2 \|\| blocked \|\| !state\.connected/);
  assert.match(s,/await diagnoseC3SdWireReadOnly\(\)/);
  assert.match(html,/capture-preview\.js\?v=1\.0\.0-c3-cold-recovery1/);
});
