'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const button=source.split("document.getElementById('diagnoseDeviceSDRecorder')?.addEventListener('click',async()=>{")[1]
  .split("document.getElementById('",1)[0];
test('C3 cold slider recovery is visible but optional for legacy op34',()=>{
 assert.match(source,/Number\.isSafeInteger\(data\.coldRecovery\)\?data\.coldRecovery:0/);
 assert.match(source,/Number\.isSafeInteger\(data\.resetReason\)\?data\.resetReason:null/);
 assert.match(source,/coldRecovery===1/);
 assert.match(source,/coldRecovery===2/);
 assert.match(source,/coldRecovery===3/);
 assert.match(source,/current SD FAT is verified mounted/);
 assert.match(source,/slider OFF for 30 seconds/);
 assert.match(source,/Boot reset /);
 assert.match(source,/coldRecovery,resetReason,restored/);
 assert.match(html,/capture-preview\.js\?v=1\.0\.0-c3-cold-recovery1/);
});
test('C3 recorder health stays RAM-only and never modifies files',()=>{
 const start=source.indexOf('const response=await client().request(34);');
 const end=source.indexOf("reportSDStage('@all','c3-recorder-health-readonly'",start);
 assert(start>=0 && end>start);
 const content=source.slice(start,end);
 assert.doesNotMatch(content,/request\(17\)|request\(18\)|request\(19\)|api\(\)\.catalogue\(|api\(\)\.refreshSD\(|deleteSDItem\(|formatSD\(/);
});
