'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const src=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const html=fs.readFileSync('index.html','utf8');
function section(first,last) {
  const start=src.indexOf(first),end=src.indexOf(last,start);
  assert(start>=0&&end>start,'missing target section '+first);
  return src.slice(start,end);
}
const single=section("action.addEventListener('click', async () => {","wifi.type = 'button'");
const libraryBrowse=section("const libraryBrowse = document.getElementById('libraryBrowseSD')","const librarySync = document.getElementById('librarySyncSD')");
const librarySync=section("const librarySync = document.getElementById('librarySyncSD')","const extras = document.getElementById('settingsDeviceExtras')");
const batch=section("async function syncAll() {","async function offerDeleteSynced(paths) {");
const post=section("async function reportC3PostSync(path, connection) {","async function syncAll() {");
const download=section("async function moveSD(path, progress = () => {})","async function clearSD() {");

test('C3 Library sync never re-browses FAT after verified download',()=>{
  assert.match(librarySync,/if \(root\.SynapModules\?\.client\?\.module\?\.id !== 2\)\s*await browseSD\('librarySDList'\)/);
  assert.match(single,/if \(root\.SynapModules\?\.client\?\.module\?\.id !== 2\)\s*await browseSD\(list\.id\)/);
  assert.match(batch,/if \(!isC3\) await api\(\)\.catalogue\(\)\.catch/);
  assert.match(html,/capture-preview\.js\?v=1\.0\.0-c3-[a-z0-9-]+/);
});

test('explicit Browse SD remains functional for C3 only on user action',()=>{
  assert.match(libraryBrowse,/libraryBrowse\?\.addEventListener\('click'/);
  assert.match(libraryBrowse,/await browseSD\('librarySDList'\)/);
  assert.doesNotMatch(libraryBrowse,/module\?\.id !== 2/);
});

test('verified C3 import survives a detected post-sync SD fault and stops rest of batch',()=>{
  assert.match(post,/diag\.sdState === 2/);
  assert.match(post,/info\?\.sdDetectionState === 2/);
  assert.match(post,/c3-sd-unavailable-after-sync/);
  assert.match(post,/return cardAvailable/);
  assert.match(download,/localStorage\.setItem\(key, JSON\.stringify\(receipt\)\)/);
  assert.match(download,/sdAvailableAfterSync = liveModule\?\.id === 2/);
  assert.match(download,/sdAvailableAfterSync \}/);
  assert.match(batch,/result\?\.sdAvailableAfterSync === false/);
  assert.match(batch,/c3-batch-paused-card-unavailable/);
  assert.match(librarySync,/result\.sdUnavailableAfterSync/);
  for(const fn of [post,download,batch,libraryBrowse,librarySync])
    assert.doesNotMatch(fn,/request\(19\)|request\(17\)|request\(14\)/);
});
