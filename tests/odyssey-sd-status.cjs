'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const caps = require('../devices/capabilities.js');
const profiles = require('../devices/profiles.js');
const { decode } = require('../devices/modules.js');
function info(id, version, state, supported = 0, ready = 0, media = 0) {
  const v = new DataView(new ArrayBuffer(20));
  [0xc7, 1, id, 1].forEach((n, i) => v.setUint8(i, n));
  v.setUint16(4, supported, true); v.setUint16(6, ready, true);
  v.setUint8(14, media); v.setUint8(17, version); v.setUint8(18, state);
  return decode(v);
}
function render(module) {
  const nodes = {};
  const element = () => ({ dataset: {}, children: [], replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); }, addEventListener() {} });
  const document = { readyState: 'complete', getElementById(id) { return nodes[id] ||= element(); },
    createElement: element, querySelectorAll: () => [] };
  vm.runInNewContext(fs.readFileSync('devices/panel.js', 'utf8'), {
    document, SynapCapabilities: caps, SynapModules: { client: { module }, ERRORS: [] },
    addEventListener() {},
  });
  return nodes;
}
test('Odyssey reports boot SD state and C3 media-v1 unlocks only SD transfer', () => {
  for (const id of [1, 2]) for (const state of [0, 1, 2, 3]) {
    const module = info(id, 1, state), nodes = render(module);
    assert.equal(module.sdDetectionState, state);
    assert.equal(caps.hasMedia(module), false, 'legacy detection-only descriptors stay media-locked');
    assert.equal(nodes.chakshuChecks.hidden, true);
    assert.match(nodes.moduleFeatures.children[0].textContent,
      [/not checked/, /detected at startup/, /check failed at startup/, /not detected at startup/][state]);
    if (state === 1) assert.match(nodes.moduleStatus.textContent, /detected at startup/);
    if (state === 2) assert.match(nodes.moduleStatus.textContent, /wiring and filesystem/);
    if (state === 3) assert.match(nodes.moduleStatus.textContent, /restart the pendant/);
  }

  const sd = profiles.FLAGS.sd;
  const c3 = info(2, 1, 1, sd, sd, 1), nodes = render(c3);
  assert.equal(caps.supports(c3, 'sd'), true);
  assert.equal(caps.ready(c3, 'sd'), true);
  assert.equal(caps.hasMedia(c3), true);
  assert.equal(caps.canCapture(c3, 'photo'), false);
  assert.equal(nodes.chakshuChecks.hidden, true, 'C3 SD media must not expose Chakshu hardware controls');
  assert.match(nodes.moduleStatus.textContent, /SD card ready/);
  assert.match(nodes.moduleStatus.textContent, /Offline WAV recordings appear in Memories/);
});
test('C3 write-only firmware is presented as offline validation instead of failed storage', () => {
  const all = profiles.FLAGS.audio | profiles.FLAGS.sd | profiles.FLAGS.settings |
    profiles.FLAGS.touch | profiles.FLAGS.battery | profiles.FLAGS.standby |
    profiles.FLAGS.sdAudio;
  const module = info(2, 1, 0, all, all & ~(profiles.FLAGS.sd | profiles.FLAGS.sdAudio), 0);
  const nodes = render(module);
  const labels = nodes.moduleFeatures.children.map(child => child.textContent);
  assert(labels.includes('SD card · offline recorder'));
  assert(labels.includes('SD card · checked on offline double-tap'));
  assert.match(nodes.moduleStatus.textContent, /Offline SD validation mode/);
  assert.match(nodes.moduleStatus.textContent, /double-tap starts recording/);
  assert.match(nodes.moduleStatus.textContent, /sync are intentionally disabled/);
});

test('old and unknown descriptors do not claim an SD result; Chakshu ignores the extension', () => {
  for (const id of [1, 2]) for (const [version, state] of [[0, 0], [2, 1], [1, 255]]) {
    const module = info(id, version, state);
    assert.equal(module.sdDetectionState, null);
    assert.match(render(module).moduleFeatures.children[0].textContent, /update firmware/);
  }
  const module = info(3, 1, 1), nodes = render(module);
  assert.equal(module.sdDetectionState, null);
  assert.equal(nodes.moduleFeatures.children.length, 0);
  assert.equal(nodes.chakshuChecks.hidden, false);
});

test('C3 reads offline recorder first fault even when catalogue fails',()=>{
 const fs=require('node:fs');
 const media=fs.readFileSync('devices/chakshu/media.js','utf8');
 const app=fs.readFileSync('app.js','utf8');
 const flow=media.split('async function syncPendingSD() {')[1].split('const apiObject = {')[0];
 assert.match(flow,/let files;/);
 assert.match(flow,/files = await catalogueNow\(\)/);
 assert.match(flow,/finally \{/);
 assert(flow.indexOf('camera().request(27)') < flow.indexOf('c3SdRetryCount = 0'));

 assert.match(flow,/await root\.SynapModules\?\.refresh\?\.\(\)\.catch/);
 assert.match(flow,/liveModule\?\.id === 2 && Number\(liveModule\.sdProbeState\) >= 40/);
 assert.match(flow,/camera\(\)\.request\(27\)/);
 assert.match(flow,/stage: 'offline-recorder-first-fault'/);
 assert.match(app,/operation === 27 \? "C3 SD offline recorder diagnostics"/);
 const src=fs.readFileSync('devices/chakshu/transfer.js','utf8');
 assert.match(src,/return this\.serialize\(\(\) => this\._request\(op, offset, path, signal\)\)/);
});

test('C3 read-only recorder fault is reported when SD catalogue rejects NO_SD', async () => {
 const media=fs.readFileSync('devices/chakshu/media.js','utf8');
 const implementation='async function syncPendingSD() {' +
   media.split('async function syncPendingSD() {')[1].split('const apiObject = {')[0];
 const events=[], operations=[];
 const cardError=Object.assign(new Error('SD card unavailable.'),{mediaCode:3});
 const context={
   owner:'account',autoSyncPromise:null,working:false,session:null,offline:false,wifi:null,
   error:'',c3SdRetryCount:0,
   connected:()=>({deviceId:'odyssey-c3'}),
   ready:()=>true,
   moduleInfo:()=>({id:2,sdProbeState:72}),
   sdWorthCataloguing:()=>true,
   catalogueNow:async()=>{throw cardError;},
   check:()=>{},
   camera:()=>({request:async op=>{
     operations.push(op);
     return {bytes:new TextEncoder().encode(JSON.stringify({
       recordStage:72,recordBytes:3980000,wrE:5,wrD:419889408
     }))};
   }}),
   TextDecoder,TextEncoder,
   CustomEvent:class {constructor(type,init){this.type=type;this.detail=init.detail;}},
   root:{
     SynapModules:{refresh:async()=>{}},
     SynapChakshuV2:{busy:false},
     SynapAppControls:{recordingState:()=>({active:false})},
     document:{body:{dataset:{otaCommitted:'false'}}},
     dispatchEvent:event=>events.push(event),
     setTimeout:()=>{throw Error('NO_SD must not schedule automatic recovery');}
   }
 };
 vm.createContext(context);
 vm.runInContext(implementation,context);
 await assert.rejects(context.syncPendingSD(),/SD card unavailable/);
 assert.deepEqual(operations,[27]);
 assert.equal(events.length,1);
 assert.equal(events[0].type,'synap-capture-diagnostic');
 assert.equal(events[0].detail.operation,27);
 assert.equal(events[0].detail.storage.recordStage,72);
 assert.equal(events[0].detail.storage.wrD,419889408);
});
