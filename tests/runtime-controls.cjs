'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const runtime=fs.readFileSync(path.join(__dirname,'..','runtime-ui.js'),'utf8');
const compat=fs.readFileSync(path.join(__dirname,'..','runtime-compat.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const sw=fs.readFileSync(path.join(__dirname,'..','sw.js'),'utf8');

assert.match(runtime,/installBlobRegistry\(\)/,'runtime must retain object-url to Blob mapping for synchronous export');
assert.match(runtime,/\^\(load audio\|play\)\$/i,'legacy duplicate Play/Load audio action must be recognized');
assert.match(runtime,/load\.hidden=true/,'lazy loader must be hidden so the native audio player is the single playback affordance');
assert.match(runtime,/data-synap-export/,'recording export must be intercepted before the legacy async download path');
assert.match(runtime,/navigator\.share/,'mobile export should use the native share sheet when file sharing is supported');
assert.match(runtime,/window\.open\(url,'_blank','noopener'\)/,'iOS fallback must open the prepared WAV while the tap activation is still live');
assert.match(runtime,/anchor\.download=name/,'desktop export must keep direct WAV download');
assert.match(runtime,/touch-action:manipulation/,'tap targets must opt out of delayed double-tap handling');
assert.match(runtime,/min-height:44px/,'primary controls must meet the minimum mobile tap target');
assert.match(compat,/bindSettingsSafetyNet/,'settings must retain a fallback even if app initialization stops early');
assert.match(compat,/settingsButton\.addEventListener\('click'/,'settings safety net must be wired directly');
assert(html.indexOf('runtime-compat.js')<html.indexOf('app.js'),'compatibility guard must load before app.js');
assert.match(sw,/shell30-processing-recovery/,'service worker cache must retain controls compatibility while shipping processing recovery');
assert.match(sw,/\.\/runtime-compat\.js/,'service worker must continue caching the controls compatibility guard');

const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
assert.match(app,/function bindCoreControls\(\)/,'core Connect and Settings controls must have an early binder');
assert(app.indexOf('bindCoreControls();',app.indexOf('async function initialize'))<app.indexOf('await journal.open()'),'core controls must bind before IndexedDB open/recovery');
const core=app.slice(app.indexOf('function bindCoreControls()'),app.indexOf('function bindEvents()'));
assert.match(core,/ui\.connectButton\.addEventListener/,'Connect must be in the early core binder');
assert.match(core,/ui\.settingsButton\.addEventListener/,'Settings must be in the early core binder');
assert.equal((app.match(/ui\.connectButton\.addEventListener/g)||[]).length,1,'Connect must be bound exactly once');
assert.equal((app.match(/ui\.settingsButton\.addEventListener/g)||[]).length,1,'Settings must be bound exactly once in app.js');

console.log('runtime recording controls and tap responsiveness: ok');
