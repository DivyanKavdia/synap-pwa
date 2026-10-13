'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const app=fs.readFileSync('app.js','utf8');
const preview=fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const transfer=fs.readFileSync('devices/chakshu/transfer.js','utf8');

test('C3 AP handoff stops all background BLE recovery and advertisement monitoring',()=>{
  const requested=app.split('function reconnectRequested() {')[1].split('function stopAdvertisementWatch()')[0];
  assert.match(requested,/c3PrivateWifiHandoffActive\(\) && !recordingReconnectPending/);
  const gate=app.split('function c3PrivateWifiHandoffActive() {')[1].split('function reconnectRequested()')[0];
  assert.match(gate,/SynapChakshuV2\?\.isC3ApHandoffActive\?\.\(\)/);
  const monitor=app.split('function monitorAllowed() {')[1].split('function watchRememberedAdvertisements()')[0];
  assert.match(monitor,/reconnectRequested\(\)/);
  const worker=app.split('async function recoverRememberedConnection(')[1].split('function bindReconnectRecovery()')[0];
  assert.match(worker,/!reconnectRequested\(\)/);
  const timer=app.split('function scheduleAutoReconnect() {')[1].split('async function connectPendant(')[0];
  assert.match(timer,/c3PrivateWifiHandoffActive\(\) && !recordingReconnectPending/);
  assert.match(timer,/c3PrivateWifiHandoffActive\(\) \|\| firmwareBusy/);
  assert.match(app,/addEventListener\?\.\("synap-c3-ap-handoff-ended"/);
  assert.match(app,/privateWifiHandoff/);
});

test('private AP credentials/owner survive BLE drop and retire when firmware session expires',()=>{
  const start=preview.split('async function startC3Ap() {')[1].split('async function stopC3Ap()')[0];
  assert.match(start,/const connection=context\(\), owner=api\(\)\?\.state\?\.owner/);
  assert.match(start,/showC3ApInfo\(ap,\{deviceId:connection\.deviceId,owner\}\)/);
  const cache=preview.split('function showC3ApInfo(next, trustedIdentity=null) {')[1].split('const node=document.getElementById')[0];
  assert.match(cache,/if\(identity\?\.deviceId && identity\?\.owner\)c3BridgeIdentity/);
  assert.match(cache,/c3BridgeHandoffStartedAt=Date\.now\(\)/);
  assert.match(cache,/root\.setTimeout/);
  assert.match(cache,/showC3ApInfo\(null\)/);
  assert.match(cache,/synap-c3-ap-handoff-ended/);
  assert.match(preview,/C3_AP_HANDOFF_MAX_MS=925000/);
  assert.match(preview,/isC3ApHandoffActive: \(\) => Boolean\(c3BridgeAp\?\.active && c3BridgeHandoffStartedAt/);
  assert.match(preview,/Date\.now\(\)-c3BridgeHandoffStartedAt<C3_AP_HANDOFF_MAX_MS/);
});

test('single BLE op20 returns credentials before hotspot activation; legacy fallback kept',()=>{
  assert.match(transfer,/const started=await this\._request\(20, 0, '', signal\)/);
  assert.match(transfer,/if\(next\?\.active\)/);
  assert.match(transfer,/return next/);
  assert.match(transfer,/next=await this\._c3ApStatus\(signal\)/);
  const bridge=preview.split('function openC3Bridge() {')[1].split('function c3BridgeAck(')[0];
  assert.match(bridge,/root\.open\(target,'synapC3Direct'\)/);
  assert.doesNotMatch(bridge,/await client\(\)|root\.SynapDevices\?\.connection/);
});
