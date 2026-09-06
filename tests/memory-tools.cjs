'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');

test('memory tools keep source recordings untouched and expose reversible merge',()=>{
  const src=fs.readFileSync(path.join(root,'memory-tools.js'),'utf8');
  assert.match(src,/\/v1\/memory-merges/);
  assert.match(src,/source_recording_ids/);
  assert.match(src,/Unmerge/);
  assert.match(src,/Source audio stays unchanged in Library/);
  assert.doesNotMatch(src,/objectStore\(['"]recordings['"]\)\.delete/);
  assert.doesNotMatch(src,/\.remove\(/);
});

test('merge UI enforces two-to-five consecutive memories before backend call',()=>{
  const src=fs.readFileSync(path.join(root,'memory-tools.js'),'utf8');
  assert.match(src,/selected\.size>=5/);
  assert.match(src,/positions\[positions\.length-1\]-positions\[0\]\+1===positions\.length/);
  assert.match(src,/recording_ids:ids/);
});

test('transcript is a first-class Summary or Transcript view and recognizes You labels',()=>{
  const src=fs.readFileSync(path.join(root,'memory-tools.js'),'utf8');
  assert.match(src,/add\('Summary',summary\)/);
  assert.match(src,/add\('Transcript',transcript\)/);
  assert.match(src,/\^\(YOU\|SELF\|ME\)\$/);
  assert.match(src,/synap-transcript-speaker/);
});

test('installed PWA caches the optional memory tools module',()=>{
  const sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');
  const bridge=fs.readFileSync(path.join(root,'battery-popover-fix.js'),'utf8');
  assert.match(sw,/shell31-memory-tools/);
  assert.match(sw,/\.\/memory-tools\.js/);
  assert.match(bridge,/memory-tools\.js\?v=1\.0\.0-memory-tools1/);
});
