'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const capture=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const media=fs.readFileSync('devices/chakshu/media.js','utf8');
const profiles=fs.readFileSync('devices/profiles.js','utf8');
test('Chakshu smart photo memory records a bounded voice note and retains the visual/audio link',()=>{
  const photo=media.split('async function photo(withAudio = false) {')[1].split('// Old cached callers')[0];
  assert.match(photo,/startMediaAudio\(\{ localOnly: true \}\)/);
  assert.match(photo,/audioId: audio\.active \? audio\.recordingId : null/);
  assert.match(photo,/const chakshuMoment = capabilities\.isChakshu\(moduleInfo\(\)\)/);
  assert.match(photo,/if \(audioOwned && audio\.sessionId && chakshuMoment\) \{\s*await delay\(5000\)/);
  assert.match(photo,/await saveAudio\(audio\.sessionId\)/);
  assert.match(photo,/stopCapture\(audio\.sessionId\)/);
});
test('Only visual Chakshu SD stems fetch matching WAV companions without deleting the SD original',()=>{
  const dl=capture.split('async function download(path, signal, progress) {')[1].split('async function verifyVisual(')[0];
  assert(dl.includes('root.SynapCapabilities?.isChakshu(root.SynapModules?.client?.module)'));
  assert(dl.includes("wav = await add(stem(path) + '.wav', false)"));
  assert(dl.includes("wav = await add(stem(path) + '.wav', false)"));
  const direct=media.split('async function importSD(path, progress) {')[1].split('async function moveSD(')[0];
  assert.match(direct,/capabilities\.isChakshu\(moduleInfo\(\)\) && path\.endsWith\('\.jpg'\)/);
  assert.match(direct,/const companions = path\.endsWith\('\.mjpeg'\) \? \['json', 'wav'\] : \['wav'\]/);
  const imports=media.split('async function importFilesNow(')[1].split('async function importSD(')[0];
  assert.match(imports,/if \(audioFile\)[\s\S]*await importAudio\(/);
  assert.match(capture,/await verifyVisual\(row\.id, source\.main, source\.wav\)/);
  assert.match(capture,/keptOnSD: true/);
});
test('new smart-memory work does not edit non-Chakshu module descriptors',()=>{
  for(const id of ['esp32c3-supermini-4m','esp32s3-fh4r2-qspi-4m','xiao-esp32s3-sense-8m'])
    assert(profiles.includes(id));
});

test('Chakshu-only diagnostics do not replace existing SD remount control',()=>{
 const library=fs.readFileSync('devices/chakshu/library.js','utf8');
 assert(library.includes("api().refreshSD()"),'existing Check SD recovery preserved');
 assert(library.includes("diagnosticButton.id = 'visualDiagnoseSD'"));
 assert(library.includes("diagnosticButton.hidden = !root.SynapCapabilities?.isChakshu(info)"));
 assert(library.includes("await api().diagnoseSD()"));
});

test('Chakshu missing WAV sync reads RAM-only diagnostics without remounting or touching Odyssey paths',()=>{
  const transfer=capture.split('async function moveSD(path, progress = () => {}) {')[1]
    .split('async function clearSD()')[0];
  assert.match(transfer,/liveModule\?\.id === 3 && stage === 'download' && error\?\.mediaCode === 11/);
  assert.match(transfer,/const detail = await api\(\)\.diagnoseSD\(\)/);
  assert.match(transfer,/reportSDStage\(path, 'chakshu-file-selection'/);
  assert.match(transfer,/Use Browse SD to refresh the catalogue/);
  assert.doesNotMatch(transfer,/request\(14\)|SD\.remove|formatSD\(/);
  assert.match(transfer,/if \(liveModule\?\.id === 2\) await reportC3SyncTrace/);
});
