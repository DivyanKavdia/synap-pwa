'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../devices/chakshu/capture-preview.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const sw=fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8');
test('read-only C3 SD BLE sync shows actual contiguous byte throughput and estimated remaining time',()=>{
 assert.match(code,/function startSDSpeed\(path, notifyProgress/);
 assert.match(code,/Math\.floor\(total\*Math\.max\(0,Math\.min\(1,Number\(fraction\)\|\|0\)\)\)/);
 assert.match(code,/liveBytesPerSecond:live,averageBytesPerSecond:/);
 assert.match(code,/Math\.ceil\(\(total-bytes\)\/live\)/);
 assert.match(code,/bytes>0&&hiddenAt===null&&now-lastAdvanced>=3000/);
 assert.match(code,/speed = startSDSpeed\(path,progress\)/);
 assert.match(code,/download\(path, undefined, speed\.progress\)/);
 assert.match(code,/speed\.finish\(\)/);
 assert.match(code,/speed\?\.finish\(true\)/);
 assert.match(code,/reportSDStage\(path,'ble-speed-summary'/);
 assert.match(html,/id="librarySDSpeed"[^>]*aria-live="off"/);
 assert.match(code,/deviceSDSpeed/);
 assert.match(sw,/shell226-c3-offline-recording-resilience/);
 assert.match(html,/c3-sd-recorder-health1/);
});
test('background suspension is separated from live BLE speed without modifying SD safety',()=>{
 const helper=code.split('function startSDSpeed(path, notifyProgress = () => {}) {')[1]
   .split('\n  async function moveSD(path, progress = () => {}) {')[0];
 assert.match(helper,/document\.addEventListener\('visibilitychange',onVisibility\)/);
 assert.match(helper,/document\.removeEventListener\('visibilitychange',onVisibility\)/);
 assert.match(helper,/hiddenMs\+=Math\.max\(0,now-hiddenAt\)/);
 assert.match(helper,/samples\.splice\(0,samples\.length,\{at:now,bytes\}\)/);
 assert.match(helper,/Paused by iOS background/);
 assert.match(helper,/root\.clearInterval\(ticker\)/);
 assert.doesNotMatch(helper,/unlink\(|deleteSD\(|formatSD\(|api\(\)\.catalogue\(/);
 assert.match(code,/SD original preserved/);
});

test('BLE SD sync temporarily acquires shared screen-awake lease without affecting OTA or recording',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 assert.match(code,/beginSDTransferWake\?\.\(\)/);
 assert.match(code,/releaseWake\?\.\(\)/);
 assert.match(app,/function beginSDTransferWake\(\)/);
 assert.match(app,/sdBleSyncWakeCount > 0 && appState === 'idle' \? 'sd-ble-sync'/);
 assert.match(app,/if \(!sdBleSyncWakeCount && !firmwareBusy && appState === 'idle' &&/);
 assert.match(app,/void screenWakeLock\.acquire\(\)\.then/);
 assert.match(app,/void screenWakeLock\.release\(\)\.catch/);
 assert.match(app,/beginSDTransferWake,shellRevision/);
});

test('denied SD wake locks cool down separately from recording and OTA',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 assert.match(app,/let sdBleWakeRetryAfter = 0/);
 assert.match(app,/Date\.now\(\) >= sdBleWakeRetryAfter/);
 assert.match(app,/sdBleWakeRetryAfter = Date\.now\(\) \+ 300000/);
 assert.match(app,/screenWakeLock\.owner\?\.scope !== 'sd-ble-sync'/);
 assert.match(app,/screenWakeLock\.owner\?\.scope === 'sd-ble-sync'/);
});
