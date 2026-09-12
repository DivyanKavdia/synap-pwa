'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const repair=fs.readFileSync(path.join(root,'transcript-repair.js'),'utf8');
const history=fs.readFileSync(path.join(root,'cloud-history.js'),'utf8');
const sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');
const tasks=fs.readFileSync(path.join(root,'backend/src/http/routes/tasks.ts'),'utf8');
const transcribe=fs.readFileSync(path.join(root,'backend/src/gemini/transcribe.ts'),'utf8');

test('PWA exposes an authenticated rebuild action for existing recordings',()=>{
  assert.match(repair,/Refresh memory/);
  assert.match(repair,/process-now\?force=true/);
  assert.match(repair,/\/memory/);
  assert.match(repair,/transcriptRebuiltAt/);
  assert.match(repair,/semanticRebuiltAt/);
  assert.match(repair,/BUSY=\['recording','starting','stopping','saving','updating'\]/);
});

test('production shell loads and offline shell caches transcript repair',()=>{
  assert.match(fs.readFileSync(path.join(root,'index.html'),'utf8'),/transcript-repair\.js\?v=/);
  assert.match(sw,/\.\/transcript-repair\.js/);
  assert.match(sw,/1\.0\.0-shell67-actions/);
});

test('backend rebuilds ready recordings without re-upload or retranscription and transcript assembly fails safe',()=>{
  assert.match(tasks,/recording\.state === 'ready' && force/);
  assert.match(tasks,/state: 'uploaded'/);
  assert.match(tasks,/rebuilt: rebuild/);
  assert.match(tasks,/retranscribed_segments: 0/);
  assert.match(tasks,/skipTranscription: true, memoryOnly: true/);
  assert.match(transcribe,/comparableText\(annotated\) !== comparableText\(flat\)/);
  assert.match(transcribe,/return flat/);
});
