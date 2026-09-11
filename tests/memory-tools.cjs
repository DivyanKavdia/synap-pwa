'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const vm=require('node:vm');

test('memory tools keep source recordings untouched and expose reversible merge',()=>{
  const src=fs.readFileSync(path.join(root,'memory-tools.js'),'utf8');
  assert.match(src,/\/v1\/memory-merges/);
  assert.match(src,/source_recording_ids/);
  assert.match(src,/Unmerge/);
  assert.match(src,/Source audio stays unchanged in Library/);
  assert.doesNotMatch(src,/objectStore\(['"]recordings['"]\)\.delete/);
  assert.doesNotMatch(src,/journal\.(?:remove|clear)\(/);
  assert.doesNotMatch(src,/deleteRecording\(/);
});

test('merge UI enforces two-to-five consecutive memories before backend call',()=>{
  const src=fs.readFileSync(path.join(root,'memory-tools.js'),'utf8');
  const code=src.slice(src.indexOf('  function selectedIsConsecutive('),src.indexOf('  function ensureControls('));
  const occupied=new Set(),selected=new Set(),ctx={selected,occupiedIds:()=>occupied};
  vm.createContext(ctx);vm.runInContext(code,ctx);
  const list=Array.from({length:6},(_,i)=>({id:String(i)}));
  function check(ids){selected.clear();ids.forEach(id=>selected.add(String(id)));return ctx.selectedIsConsecutive(list)}
  assert.equal(check([0]),false);
  assert.equal(check([0,2]),false);
  assert.equal(check([0,1]),true);
  assert.equal(check([0,1,2,3,4]),true);
  assert.equal(check([0,1,2,3,4,5]),false);
  occupied.add('1');assert.equal(check([0,1]),false);
  assert.equal(check([0,2]),false,'an occupied memory cannot be skipped to fake adjacency');
});

test('one canonical memory view renders summaries, notes and transcripts',()=>{
  const src=fs.readFileSync(path.join(root,'provenance-links.js'),'utf8');
  assert.match(src,/add\('Summary',summaryPanel/);
  assert.match(src,/add\('Notes',notesPanel/);
  assert.match(src,/add\('Transcript',transcriptPanel/);
  assert.match(src,/\^\(YOU\|SELF\|ME\)\$/);
  const memory=fs.readFileSync(path.join(root,'memory-tools.js'),'utf8');
  assert.match(memory,/SynapProvenance\.buildMemoryView/);
  assert.doesNotMatch(memory,/new MutationObserver/,'merge does not observe its own DOM edits');
});

test('installed PWA caches the optional memory and sleep-state modules',()=>{
  const sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');
  const shell=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(sw,/shell55-ota-progress/);
  assert.match(sw,/\.\/memory-tools\.js/);
  assert.match(sw,/\.\/sleep-state-guard\.js/);
  assert.match(shell,/memory-tools\.js\?v=/);
});
