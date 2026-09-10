'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const stability=fs.readFileSync(path.join(root,'capture-stability.js'),'utf8');

assert.doesNotMatch(app,/MAX_RECORDING_MS/,'a user recording must not be force-stopped at an arbitrary duration');
assert.doesNotMatch(app,/Maximum recording duration reached/,'the old 50-minute forced-stop path must be removed');
assert.match(app,/recordingReconnectPending/,'the core recorder must retain an explicit interrupted-recording state');
assert.match(app,/RECORDING_RECONNECT_GRACE_MS/,'an interrupted journal needs a bounded recovery window');
assert.match(app,/beginTransportEpoch\(currentRecordingId,\s*0\)/,'BLE sequence restart must continue the existing journal rather than overwrite old frames');
assert.match(app,/completedSequences\.clear\(\)/,'raw duplicate tracking must reset for a new BLE transport epoch');
assert.match(app,/lastObservedSequence\s*=\s*null/,'raw missing-frame tracking must reset across a reconnect');
assert.match(app,/recordingResumeBluetoothId/,'resume must remain bound to the same browser Bluetooth device');
assert.match(app,/recordingResumeDeviceId/,'resume must remain bound to the same permanent pendant identity when available');
assert.match(app,/connection-lost-timeout/,'an unrecovered interrupted recording must eventually be sealed safely');
assert.match(app,/Recording paused/i,'the disconnected UI should visibly identify the paused recording state');
assert.match(app,/continue the same recording/i,'the disconnected UI should explain that reconnect continues the preserved recording');
assert.equal((app.match(/journal\.begin\(/g)||[]).length,1,'transport recovery must never create a second local recording');

// The normalizer itself must turn a restarted uint16 firmware counter into the
// next logical frame of the same recording.
const context={console,Map,Number,String,Math,Object,Promise,setInterval(){return 1},clearInterval(){},sessionStorage:{removeItem(){}},globalThis:null};
context.globalThis=context;
vm.createContext(context);
vm.runInContext(stability,context,{filename:'capture-stability.js'});
const api=context.SynapCaptureStability;
assert.equal(api.relativeSequence('r1',42),0);
assert.equal(api.relativeSequence('r1',43),1);
assert.equal(api.beginTransportEpoch('r1',0),true);
assert.equal(api.relativeSequence('r1',0),2,'a restarted firmware sequence must append after the previous logical frame');

console.log('PASS: long recordings stay single-file and BLE reconnect resumes the same journal safely.');
