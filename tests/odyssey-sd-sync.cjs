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
assert.match(transfer,/this\._request\(readOp, size, readPath, signal, c3WindowPath\)/);
assert.match(transfer,/revision: '1\.0\.0-chakshu-core18'/);
assert.match(media,/Odyssey SD audio/);
assert.match(media,/schedulePendingSync\(250\)/);
assert.match(media,/root\.document\?\.body\?\.dataset\.otaRecovery === 'c3'/,'Odyssey automatic catalogue must be suppressed only during OTA recovery');
assert.match(media,/camera\(\)\.request\(14/);
assert.match(preview,/id = 'deviceSDSettings'/);
assert.match(preview,/Clear SD Card/);
assert.match(preview,/Format SD Card/);
assert.match(preview,/request\(19\)/);
assert.match(preview,/ALL files on the card will be permanently erased/);
const settingsRender=preview.indexOf("settings = document.getElementById('deviceSDSettings')"),
  libraryPanelReturn=preview.indexOf('if (!panel) return;', settingsRender);
assert(settingsRender>=0 && libraryPanelReturn>settingsRender,
  'Settings SD state must render before Library-panel early return');
assert.match(preview,/await verifyAudio\(record\.id, source\.main\)/);
assert.match(preview,/synap-sd-sync-diagnostic/);
for(const stage of ['download','import','verify','already-synced','complete','delete-user-requested','failed'])
  assert(preview.includes(stage),'sync diagnostics must expose '+stage);
const verified=preview.indexOf('await verifyAudio(record.id, source.main)');
assert(verified>=0);
const receiptSaved=preview.indexOf('localStorage.setItem(key, JSON.stringify(receipt))',verified);
assert(receiptSaved>verified,'verified sync must persist a receipt before returning success');
const moveEnd=preview.indexOf('async function clearSD()',receiptSaved);
assert(moveEnd>receiptSaved);
assert(!preview.slice(receiptSaved,moveEnd).includes('await deleteSyncedSet(path)'),
  'successful sync must retain the SD source until explicit user deletion');
assert.match(preview,/return \{ \.\.\.cached, alreadySynced: true, keptOnSD: true \}/,
  'a verified receipt must prevent duplicate import while the SD source remains');
assert.match(preview,/const isSDSynced = \(path\) => Boolean\(storedReceipt\(path\)\)/);
assert.match(preview,/async function deleteSDItem\(path\)/);
assert.match(preview,/Delete this recording from the device SD card now\?/);
assert.match(media,/file\?\.syncable !== false && bytes > 44/,'legacy and new catalogues must classify empty/header-only WAVs as incomplete');
assert.match(preview,/blocked-incomplete-source/,'verified sync must reject incomplete SD artifacts before transfer');
assert.match(library,/Incomplete SD recording/,'Memories must distinguish incomplete artifacts from syncable recordings');
assert.match(library,/Cannot sync · no audio was written/);
assert.match(library,/Not synced · On device SD/);
assert.match(library,/Synced to Memories · Also on device SD/);
assert.match(library,/Synced · SD copy retained/);
assert.match(library,/Syncing from device SD/);
console.log('PASS: Odyssey C3 SD sync retains explicit SD copies, prevents duplicate imports, and offers user-controlled deletion.');

assert.match(preview,/async function discardIncompleteSD\(path\)/,'incomplete SD files retain their exact-path cleanup action');
assert.match(preview,/delete-incomplete-source/);
assert.match(library,/library-sd-discard/,'Memories must expose an SD delete action');
assert.match(library,/Delete from SD/);
assert.match(library,/SynapChakshuV2\?\.deleteSDItem/);
assert.match(library,/without syncing it to Memories/,'unsynced SD deletion must require an explicit destructive confirmation');
assert.match(library,/The synced copy in Memories will be kept/,'post-sync SD deletion must preserve the Memory copy');

assert.match(transfer,/C3_SD_READ_TIMEOUT_MS = 20000/,'C3 SD reads need margin above observed ~10 second Bluefy bridge stalls');
assert.match(transfer,/RESPONSE_DEADLINE_MS = 30000/);
assert.match(library,/Syncing to Memories · 0%/,'SD cards must show foreground transfer progress');
assert.match(library,/Sync paused · tap again to retry/);
assert.match(preview,/SD transfer in progress · SD maintenance controls are temporarily disabled/);

const modulesSource=fs.readFileSync(path.join(root,'devices/modules.js'),'utf8');
assert.match(modulesSource,/profile\.id === 2 \? value\.getUint8\(16\) & 7 : 0/,
  'C3 must accept notification-window, Wi-Fi and explicit format media feature bits');
assert.match(transfer,/if \(this\.features & 1 && !this\.streamDisabled\)/,
  'C3 media-v2 uses the existing notification-window transport');
assert.match(transfer,/this\.window\(size, first\.total, signal\)/);

assert.match(transfer,/configureC3Wifi\(ssid, password, signal\)/,
  'C3 Wi-Fi credentials must be provisioned through the existing BLE media channel');
assert.match(transfer,/startC3WifiUpload\(options, signal\)/);
assert.match(transfer,/c3WifiStatus\(signal\)/);
assert.match(transfer,/forgetC3Wifi\(signal\)/);
assert.match(media,/moduleInfo\(\)\?\.id === 2[\s\S]*moduleInfo\(\)\?\.mediaFeatures & 2/,
  'C3 direct Wi-Fi capability must use bit 1 without changing Chakshu hotspot bit 2');
assert.match(preview,/WIFI_UPLOAD_PREFIX = 'synap-c3-wifi-upload-v1:'/);
assert.match(preview,/async function moveC3Wifi\(path, sourceEntry, progress/);
assert.doesNotMatch(preview,/wifiState\?\.configured\) return moveC3Wifi/,
  'ordinary Sync to Memories must remain Bluetooth; Wi-Fi transfer is an explicit user action');
assert.match(preview,/Transfer over Wi-Fi/,'C3 SD rows must expose an explicit Wi-Fi transfer action');
assert.match(preview,/id = 'deviceWifiSettings'/);
assert.match(preview,/Save Wi-Fi/);
assert.match(preview,/Forget Wi-Fi/);
assert.match(preview,/\/v1\/device-uploads/);
assert.match(preview,/SynapCloudHistory\?\.restore/);
assert.match(preview,/localStorage\.removeItem\(ticket\.key\)/);
assert.match(preview,/wifi-verified/);

assert.match(media,/crc32 = Number\(file\?\.crc32\)/,'C3 catalogue must preserve optional firmware CRC metadata');
assert.match(media,/pcmBytes \+ 44 === bytes/,'C3 catalogue must validate firmware PCM length metadata');
assert.match(media,/take = \/\^\[0-9a-f\]\{16\}\$\/i/,'C3 catalogue must preserve stable take identity');
assert.match(preview,/function crc32\(bytes, start = 0\)/,'PWA must implement the same CRC32 used by firmware');
assert.match(preview,/verifyFirmwareCrc\(source\.main, sourceEntry\)/,'BLE SD sync must verify firmware CRC before import');
const crcVerify=preview.indexOf('verifyFirmwareCrc(source.main, sourceEntry)');
const importStage=preview.indexOf("stage = 'import'",crcVerify);
assert(crcVerify>=0 && importStage>crcVerify,'CRC verification must complete before durable import');
assert.match(preview,/SD recording integrity check failed before import\. The SD original was kept\./);
