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
 assert.match(code,/id=\\"deviceSDSpeed\\"/);
 assert.match(sw,/shell217-c3-speed-meter/);
 assert.match(html,/c3-speed-meter1/);
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
