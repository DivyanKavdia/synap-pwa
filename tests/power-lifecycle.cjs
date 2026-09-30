'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');

test('PWA idles into protocol-compatible firmware standby only on safe builds',()=>{
  const src=fs.readFileSync(path.join(root,'devices/power.js'),'utf8');
  assert.match(src,/CMD_STANDBY=0x03/);
  assert.match(src,/IDLE_TO_STANDBY_MS=30000/);
  assert.match(src,/MIN_SAFE_STANDBY_BUILD=1125/);
  assert.match(src,/firmwareBuild>=MIN_SAFE_STANDBY_BUILD/);
  assert.match(src,/document\.body\?\.dataset\?\.deviceState==='1'/);
  assert.match(src,/new Uint8Array\(\[CMD_STANDBY,PROTOCOL_VERSION\]\)/);
  assert.match(src,/firmwareBuild=\(bytes\[4\]\|\|0\)\|\(\(bytes\[5\]\|\|0\)<<8\)/);
  assert.match(src,/CMD_WAKE=0x04/);
  assert.match(src,/async function wakeForActivity\(\)/);
  assert.match(src,/new Uint8Array\(\[CMD_WAKE,PROTOCOL_VERSION\]\)/);
  assert.match(src,/Wake pendant for device activity/);
  assert.match(src,/lastPowerState===POWER_STANDBY\|\|document\.body\?\.dataset\?\.powerState==='standby'/);
  assert.match(src,/wakeForActivity/);
  assert.match(src,/restartAwaitingReconnect/);
  assert.match(src,/synap-firmware-restart-reconnected/);
  assert.match(src,/SynapModules\?\.refresh\?\.\(\)/);
  assert.match(src,/CMD_RESTART=0x05/);
  assert.match(src,/MIN_RESTART_BUILD=1508/);
  assert.match(src,/async function restartFirmware\(\)/);
  assert.match(src,/new Uint8Array\(\[CMD_RESTART,PROTOCOL_VERSION\]\)/);
  assert.match(src,/Restart pendant firmware/);
  assert.match(src,/firmwareBuild<MIN_RESTART_BUILD/);
  assert.match(src,/state\(\)!=='idle'/);
});

test('head-loaded bridge binds state observer once body becomes available',()=>{
  const src=fs.readFileSync(path.join(root,'devices/power.js'),'utf8');
  assert.match(src,/function bindStateObserver\(\)/);
  assert.match(src,/DOMContentLoaded/,'head script must defer observer binding when body does not exist yet');
  assert.match(src,/attributeFilter:\['data-state','data-device-state'\]/);
  assert.match(src,/onStateChange\(\)/);
});

test('retained deep-sleep wake-record event starts only through normal app Start',()=>{
  const src=fs.readFileSync(path.join(root,'devices/power.js'),'utf8');
  assert.match(src,/POWER_WAKE_RECORD=4/);
  assert.match(src,/synap-event-packet/);
  assert.match(src,/autoStartPending=true/);
  assert.match(src,/button\.click\(\)/);
  assert.match(src,/state\(\)!=='idle'\|\|!button\|\|button\.disabled/);
});

test('power bridge never sends standby during recording, saving, OTA or connection setup',()=>{
  const src=fs.readFileSync(path.join(root,'devices/power.js'),'utf8');
  assert.match(src,/function eligibleIdle\(\).*state\(\)==='idle'/s);
  assert.match(src,/if\(s==='idle'\).*else cancelStandby\(\)/s);
  assert.match(src,/standby command failed/);
});

test('Settings exposes restart only for restart-capable idle firmware',()=>{
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const src=fs.readFileSync(path.join(root,'devices/power.js'),'utf8');
  assert.match(html,/id="firmwareRestart"[^>]*hidden[^>]*>Restart firmware<\/button>/);
  assert.match(src,/button\.hidden=!supported/);
  assert.match(src,/button\.disabled=!supported\|\|state\(\)!=='idle'\|\|writeBusy/);
  assert.match(src,/confirm\('Restart the connected pendant firmware now\?/);
  assert.match(src,/synap-gatt-disconnected/);
});
