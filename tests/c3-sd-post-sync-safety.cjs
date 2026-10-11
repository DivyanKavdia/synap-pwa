'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const code=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const page=fs.readFileSync('index.html','utf8');
const rows=code.split('function renderSDRows(')[1].split('async function browseSD(')[0];
const move=code.split('async function moveSD(')[1].split('async function clearSD(')[0];
const batch=code.split('async function syncAll() {')[1].split('async function offerDeleteSynced(')[0];
const deleteOffer=code.split('async function offerDeleteSynced(')[1].split('function upgradeUi(')[0];
const rawDiag=code.split('async function reportC3PostSync(')[1].split('async function syncAll(')[0];

test('C3 successful SD import saves receipt and checks status without new FAT reads',()=>{
  assert.match(move,/localStorage\.setItem\(key, JSON\.stringify\(receipt\)\)/);
  assert.match(move,/await reportC3PostSync\(path, connection\)/);
  assert.match(rawDiag,/client\(\)\.request\(27\)/);
  assert.match(rawDiag,/root\.SynapModules\?\.refresh\?\.\(\)/);
  assert.doesNotMatch(rawDiag,/request\((?:4|7|14|17|18|19)\)|catalogue\(|deleteSDItem\(|refreshSD\(/);
  assert.match(rawDiag,/ioOp: diag\.ioOp/);
  assert.match(rawDiag,/sdLiveProbeState/);
  assert.match(page,/capture-preview\.js\?v=1\.0\.0-c3-sync-no-recatalogue/);
});

test('C3 sync batch stops after first failing read, without post-sync catalogue or implicit deletion',()=>{
  assert.match(batch,/if \(isC3\) \{/);
  assert.match(batch,/c3-batch-stopped-after-read-error/);
  assert.match(batch,/if \(!isC3\) await api\(\)\.catalogue\(\)/);
  assert.match(deleteOffer,/if \(root\.SynapModules\?\.client\?\.module\?\.id === 2\)/);
  assert.match(deleteOffer,/return 0/);
  assert.doesNotMatch(deleteOffer.split('if (root.SynapModules?.client?.module?.id === 2)')[1].split('const unique =')[0],/confirm\(|deleteSDItem\(/);
});

test('C3 single-file and Wi-Fi sync retain originals; no automatic catalogue after verified transfer',()=>{
  assert.match(rows,/SD original kept/);
  assert.match(rows,/C3 SD original kept/);
  assert.equal((rows.match(/if \(root\.SynapModules\?\.client\?\.module\?\.id !== 2\)\s+await browseSD\(list\.id\)\.catch/g)||[]).length,2);
  assert.match(code,/if \(root\.SynapModules\?\.client\?\.module\?\.id !== 2\)\s+await browseSD\('librarySDList'\)/);
});
