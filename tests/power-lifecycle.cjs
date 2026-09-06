'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');

test('PWA idles into protocol-compatible firmware standby',()=>{
  const src=fs.readFileSync(path.join(root,'battery-popover-fix.js'),'utf8');
  assert.match(src,/CMD_STANDBY=0x03/);
  assert.match(src,/IDLE_TO_STANDBY_MS=30000/);
  assert.match(src,/document\.body\?\.dataset\?\.deviceState==='1'/);
  assert.match(src,/new Uint8Array\(\[CMD_STANDBY,PROTOCOL_VERSION\]\)/);
  assert.doesNotMatch(src,/CMD_WAKE/,'START remains the one command that wakes standby and starts capture');
});

test('head-loaded bridge binds state observer once body becomes available',()=>{
  const src=fs.readFileSync(path.join(root,'battery-popover-fix.js'),'utf8');
  assert.match(src,/function bindStateObserver\(\)/);
  assert.match(src,/DOMContentLoaded', 'head script must defer observer binding when body does not exist yet');
  assert.match(src,/attributeFilter:\['data-state','data-device-state'\]/);
  assert.match(src,/onStateChange\(\)/);
});

test('retained deep-sleep wake-record event starts only through normal app Start',()=>{
  const src=fs.readFileSync(path.join(root,'battery-popover-fix.js'),'utf8');
  assert.match(src,/POWER_WAKE_RECORD=4/);
  assert.match(src,/synap-event-packet/);
  assert.match(src,/autoStartPending=true/);
  assert.match(src,/button\.click\(\)/);
  assert.match(src,/state\(\)!=='idle'\|\|!button\|\|button\.disabled/);
});

test('power bridge never sends standby during recording, saving, OTA or connection setup',()=>{
  const src=fs.readFileSync(path.join(root,'battery-popover-fix.js'),'utf8');
  assert.match(src,/eligibleIdle\(\).*state\(\)==='idle'/s);
  assert.match(src,/if\(s==='idle'\).*else cancelStandby\(\)/s);
  assert.match(src,/standby command failed/);
});
