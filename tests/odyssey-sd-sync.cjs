'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const profiles=require('../devices/profiles.js');
const caps=require('../devices/capabilities.js');
const c3=profiles.BY_MODULE[2];
const info={...c3,supported:1|4|8|16|32|64|256,ready:1|4|8|16|32|64|256,mediaVersion:1,legacy:false};
assert.equal(caps.hasMedia(info),true,'C3 media-v1 must be recognized');
assert.equal(caps.ready(info,'sd'),true,'C3 mounted SD must be ready');
assert.equal(caps.ready(info,'sdAudio'),true,'C3 mic + mounted SD unlock offline WAV recording');
assert(c3.features.includes('sd'));
assert.equal(c3.protocols.media,1);
const transfer=fs.readFileSync(path.join(root,'devices/chakshu/transfer.js'),'utf8');
const media=fs.readFileSync(path.join(root,'devices/chakshu/media.js'),'utf8');
const preview=fs.readFileSync(path.join(root,'devices/chakshu/capture-preview.js'),'utf8');
const library=fs.readFileSync(path.join(root,'devices/chakshu/library.js'),'utf8');
assert.match(library,/info = root\.SynapModules\?\.client\?\.module/,'SD library render must bind module capabilities before probe messaging');
assert(transfer.includes('{0,51}\\.wav'));
assert.match(transfer,/readPath = image \? '' : op === 8 \? '@catalogue' : path/);
assert.match(transfer,/this\._request\(readOp, size, readPath, signal\)/);
assert.match(transfer,/revision: '1\.0\.0-chakshu-core17'/);
assert.match(media,/Odyssey SD audio/);
assert.match(media,/schedulePendingSync\(250\)/);
assert.match(media,/root\.document\?\.body\?\.dataset\.otaRecovery === 'c3'/,'Odyssey automatic catalogue must be suppressed only during OTA recovery');
assert.match(media,/camera\(\)\.request\(14/);
assert.match(preview,/id = 'deviceSDSettings'/);
assert.match(preview,/Clear SD Card/);
const settingsRender=preview.indexOf("settings = document.getElementById('deviceSDSettings')"),
  libraryPanelReturn=preview.indexOf('if (!panel) return;', settingsRender);
assert(settingsRender>=0 && libraryPanelReturn>settingsRender,
  'Settings SD state must render before Library-panel early return');
assert.match(preview,/await verifyAudio\(record\.id, source\.main\)/);
assert.match(preview,/synap-sd-sync-diagnostic/);
for(const stage of ['download','import','verify','delete-source','complete','failed'])
  assert(preview.includes(stage),'sync diagnostics must expose '+stage);
const verified=preview.indexOf('await verifyAudio(record.id, source.main)');
assert(verified>=0);
assert(preview.indexOf('await deleteSyncedSet(path)',verified)>verified);
assert.match(media,/file\?\.syncable !== false && bytes > 44/,'legacy and new catalogues must classify empty/header-only WAVs as incomplete');
assert.match(preview,/blocked-incomplete-source/,'verified sync must reject incomplete SD artifacts before transfer');
assert.match(library,/Incomplete SD recording/,'Memories must distinguish incomplete artifacts from syncable recordings');
assert.match(library,/Cannot sync · no audio was written/);
assert.match(library,/Not synced · On device SD/);
assert.match(library,/Syncing from device SD/);
console.log('PASS: Odyssey C3 SD files surface in Memories, sync uses verified delete, and Settings exposes safe clear.');

assert.match(preview,/async function discardIncompleteSD\(path\)/,'incomplete SD files need an exact-path cleanup action');
assert.match(preview,/delete-incomplete-source/);
assert.match(preview,/entry\.syncable !== false && bytes > 44/,'cleanup must refuse valid syncable SD recordings');
assert.match(library,/library-sd-discard/,'Memories must expose cleanup for incomplete SD entries');
assert.match(library,/Remove from SD/);
assert.match(library,/SynapChakshuV2\?\.discardIncompleteSD/);

assert.match(transfer,/READ_TIMEOUT_MS = 20000/,'Bluefy SD reads need margin above observed ~10 second bridge stalls');
assert.match(transfer,/RESPONSE_DEADLINE_MS = 30000/);
assert.match(library,/Syncing to Memories · 0%/,'SD cards must show foreground transfer progress');
assert.match(library,/Sync paused · tap again to retry/);
assert.match(preview,/SD transfer in progress · Retry SD and Clear SD are temporarily disabled/);
