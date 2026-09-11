'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const html=read('index.html');
const app=read('app.js');
const sw=read('sw.js');
const battery=read('battery-popover-fix.js');
const cloud=read('cloud-history.js');
const runtime=read('runtime-ui.js');
const bridge=read('recording-bridge.js');
const sleep=read('sleep-state-guard.js');
const brain=read('brain-ui.js');
const enhancements=read('enhancements.js');
const dashboard=read('dashboard-ui.js');
const product=read('product-ui.js');
const stability=read('capture-stability.js');
const capture=read('capture-ui.js');

assert(html.includes('globalThis.SYNAP_STATIC_BOOTSTRAP=true'),'production shell must declare deterministic bootstrap');
const core=[
  'runtime-compat.js','audio-store.js','battery-popover-fix.js','capture-stability.js','sleep-state-guard.js','recording-bridge.js','event-channel.js',
  'ota.js','releases.js','app.js','google-auth.js','synap-backend.js','processing-pipeline-ui.js','memory-ui-fix.js','cloud-history.js',
  'memory-tools.js','cost-ui.js','transcript-repair.js','voice-profile.js','ask-synap.js','brain-ui.js','dashboard-ui.js','runtime-ui.js','capture-ui.js','product-ui.js','provenance-links.js','productivity-tools.js','desktop-capture.js','interaction-surfaces.js','memory-ready-events.js','experience-recovery.js'
];
let last=-1;
for(const file of core){
  const matches=[...html.matchAll(new RegExp(`src=["'][^"']*${file.replace('.','\\.')}[^"']*["']`,'g'))];
  assert.equal(matches.length,1,`${file} must be loaded exactly once by index.html`);
  assert(matches[0].index>last,`${file} must follow the deterministic bootstrap order`);
  last=matches[0].index;
  assert(sw.includes(`'./${file}'`),`${file} must also be present in the offline app shell`);
}

assert.doesNotMatch(cloud,/loadProductRuntime|loadRuntimeModule/,'index owns runtime loading');
assert.doesNotMatch(battery,/script\.src/,'battery cannot inject unrelated product scripts');
assert.match(runtime,/if\(!globalThis\.SynapRecordingBridge\)bindTouchRecordingBridge\(\)/,
  'hardware stream adoption must defer to recording-bridge');
assert.match(runtime,/if\(!globalThis\.SynapDashboardUI\)bindBrainTabs\(\)/,
  'navigation must defer to dashboard-ui');
assert.match(battery,/function tryAutoStart\(\)\{if\(root\.SynapRecordingBridge\)return;/,
  'power helper must not become a second hardware-stream adoption owner');

assert.match(sleep,/owner:'sleep-state-guard'/,'sleep-state guard must publish the canonical intentional-sleep event');
assert.match(bridge,/root\.addEventListener\('synap-intentional-sleep'/);
assert.doesNotMatch(bridge,/localStorage|POWER_EVENT_MAGIC|readSession|patchJournal/,
  'recording bridge must not duplicate sleep preference ownership or obsolete rollover APIs');

const delays=app.match(/AUTO_RECONNECT_DELAYS_MS\s*=\s*\[([^\]]+)\]/);
assert(delays,'core recorder must define the reconnect schedule');
const values=delays[1].split(',').map(v=>Number(v.trim())).filter(Number.isFinite);
assert(values.length>=6,'reconnect schedule must survive more than a few transient failures');
const horizon=values.reduce((a,b)=>a+b,0);
assert(horizon>=90000&&horizon<=130000,`reconnect horizon should align with capture continuity; got ${horizon}ms`);
assert.match(app,/MAX_AUTO_RECONNECT_ATTEMPTS = AUTO_RECONNECT_DELAYS_MS\.length/);

assert.doesNotMatch(dashboard,/\.observe\(document\.body,\{childList:true,subtree:true\}\)/,
  'dashboard must not use the whole body as its data bus');
assert.doesNotMatch(brain,/observe\(\$\('#insightsList'\)\|\|document\.body/,
  'Actions/brain refresh must use explicit memory events');
const bindBrief=enhancements.slice(enhancements.indexOf('function bindBrief()'),enhancements.indexOf("document.addEventListener('click'"));
assert.doesNotMatch(bindBrief,/MutationObserver/,'daily brief refresh must use explicit memory events');
assert.doesNotMatch(product,/Advanced & recovery/,'product UI must not recreate the removed Advanced & recovery panel');
assert.doesNotMatch(capture,/backgroundMemoryControls/,'capture UI must not rebuild manual processing controls');
assert.doesNotMatch(capture,/if\(timer\)new MutationObserver\(sync\)/,'recording timer must not trigger a full capture-header render every second');
assert(enhancements.includes("SHELL_REVISION='1.0.0-shell55-ota-progress'"),'update-notice generation must match the service worker');
assert.doesNotMatch(stability,/observe\(root\.document\.body, \{ childList: true, subtree: true \}\)/,
  'recovery hiding must not watch the entire document forever');
assert(sw.includes("const CACHE_REVISION='1.0.0-shell55-ota-progress';"),'service worker revision must advance with the architecture graph');

console.log('PASS: production bootstrap, BLE ownership, sleep ownership, render flow and reconnect policy are structurally consistent.');
