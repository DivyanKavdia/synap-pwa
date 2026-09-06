'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');

test('voice enrollment is explicit and enrollment audio is never stored locally',()=>{
  const src=fs.readFileSync(path.join(root,'voice-profile.js'),'utf8');
  assert.match(src,/I agree to create an encrypted voice profile/);
  assert.match(src,/enrollment audio is not saved/i);
  assert.match(src,/\/v1\/voice-profile/);
  assert.match(src,/Content-Type':'audio\/wav/);
  assert.doesNotMatch(src,/indexedDB\.open/);
  assert.doesNotMatch(src,/localStorage\.setItem\([^)]*voice/i);
});

test('voice profile supports setup, re-record and deletion',()=>{
  const src=fs.readFileSync(path.join(root,'voice-profile.js'),'utf8');
  assert.match(src,/setup\.textContent='Re-record'/);
  assert.match(src,/method:'DELETE'/);
  assert.match(src,/Future memories will stop identifying your speech as You/);
});

test('speaker matching is enrichment-only and conservative',()=>{
  const enrich=fs.readFileSync(path.join(root,'backend/src/speaker/enrich.ts'),'utf8');
  const process=fs.readFileSync(path.join(root,'backend/src/pipeline/process.ts'),'utf8');
  assert.match(enrich,/best\.score < config\.speaker\.matchThreshold/);
  assert.match(enrich,/minMatchMargin/);
  assert.match(enrich,/speaker: 'YOU'/);
  assert.match(enrich,/return \{ words, matchedSpeaker: null/);
  assert.match(process,/Identity is metadata enrichment, never a prerequisite for a transcript/);
});

test('installed PWA caches and loads the voice profile module',()=>{
  const sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');
  const bridge=fs.readFileSync(path.join(root,'battery-popover-fix.js'),'utf8');
  assert.match(sw,/\.\/voice-profile\.js/);
  assert.match(bridge,/voice-profile\.js/);
  assert.match(bridge,/data-synap-voice-profile/);
});

test('speaker service contract does not persist raw audio',()=>{
  const app=fs.readFileSync(path.join(root,'speaker-service/app.py'),'utf8');
  assert.match(app,/await request\.body\(\)/);
  assert.match(app,/encode_batch/);
  assert.doesNotMatch(app,/open\([^)]*,\s*["']w/);
  assert.doesNotMatch(app,/storage|bucket|firestore/i);
});
