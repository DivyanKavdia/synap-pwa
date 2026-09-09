'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const runtime=fs.readFileSync(path.join(__dirname,'..','runtime-compat.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');

assert.match(app,/document\.createElement\(\"audio\"\)/,
  'Library must continue to use native audio controls');
assert.match(app,/audio\.preload\s*=\s*\"none\"/,
  'Library should not eagerly assemble every recording');

assert.match(runtime,/function installLazyLibraryPlayback\(/,
  'runtime compatibility layer must install lazy Library playback');
assert.match(runtime,/\.classList\.contains\('recording-card'\).*card\.open/s,
  'opening a recording card should warm its source audio');
assert.match(runtime,/journal\.blob\(recording\)/,
  'journal-backed recordings must reconstruct a playable WAV from local audio');
assert.match(runtime,/audio\.src\s*=\s*url/,
  'the reconstructed object URL must be attached to the visible native player');
assert.match(runtime,/addEventListener\('pointerdown'/,
  'first interaction with an unloaded player must trigger the same lazy load');
assert.match(runtime,/Source audio is not stored on this browser\./,
  'cloud-only memories must explain why source playback is unavailable');
assert.match(runtime,/revokeObjectURL/,
  'object URLs created for playback must be released');
assert.doesNotMatch(runtime,/setInterval\([^)]*installLazyLibraryPlayback/,
  'playback must not add a polling loop');
assert.doesNotMatch(runtime,/location\.reload\(/,
  'playback recovery must never reload the PWA or tear down BLE');

new Function(runtime);
console.log('PASS: Library audio is lazy-loaded on card open/first interaction with no polling or reload.');
