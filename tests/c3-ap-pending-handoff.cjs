'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const preview=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');

test('C3 private hotspot guards BLE recovery before the first op20 exchange',()=>{
  const start=preview.split('async function startC3Ap() {')[1].split('async function stopC3Ap()')[0];
  assert(start);
  assert(start.indexOf('c3BridgeHandoffPendingAt=Date.now()')<
    start.indexOf('await client().startC3Ap()'));
  assert.match(start,/showC3ApInfo\(ap,\{deviceId:connection\.deviceId,owner\}\)/);
  assert.match(start,/finally \{[\s\S]*?c3BridgeHandoffPendingAt=0/);
  assert.match(start,/synap-c3-ap-handoff-ended/);
});

test('C3 private hotspot pending state preserves settings after link loss and is bounded',()=>{
  assert.match(preview,/let c3BridgeHandoffPendingAt=0/);
  assert.match(preview,/c3BridgeAp\?\.active \|\| c3BridgeHandoffPendingAt/);
  const api=preview.split('isC3ApHandoffActive: () =>')[1];
  assert(api);
  assert.match(api,/c3BridgeHandoffPendingAt/);
  assert.match(api,/Date\.now\(\)-c3BridgeHandoffPendingAt<60000/);
  assert.match(api,/c3BridgeAp\?\.active && c3BridgeHandoffStartedAt/);
});
