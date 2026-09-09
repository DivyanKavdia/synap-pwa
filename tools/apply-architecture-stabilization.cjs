'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

function read(name){return fs.readFileSync(path.join(root,name),'utf8')}
function write(name,text){fs.writeFileSync(path.join(root,name),text)}
function replaceOnce(source,before,after,label){
  const first=source.indexOf(before);
  if(first<0)throw new Error(`Missing architecture anchor: ${label}`);
  if(source.indexOf(before,first+before.length)>=0)throw new Error(`Ambiguous architecture anchor: ${label}`);
  return source.slice(0,first)+after+source.slice(first+before.length);
}
function replaceRegexOnce(source,replacementRegex,after,label){
  const matches=[...source.matchAll(replacementRegex)];
  if(matches.length!==1)throw new Error(`${matches.length?'Ambiguous':'Missing'} architecture anchor: ${label} (${matches.length})`);
  return source.replace(replacementRegex,after);
}

function patchIndex(source){
  let s=source;
  s=replaceOnce(s,
    '  <script src="battery-popover-fix.js?v=1.0.0"></script>\n  <script src="memory-ui-fix.js?v=0.0.1-memory1"></script>',
    '  <script>globalThis.SYNAP_STATIC_BOOTSTRAP=true;</script>',
    'remove race-loaded head modules');

  const runtime=`<script src="runtime-compat.js?v=1.0.0-controls1"></script>\n<script src="audio-store.js?v=1.0.0-prod2"></script>\n<script src="battery-popover-fix.js?v=1.0.0-arch1"></script>\n<script src="capture-stability.js?v=1.0.0-stability3"></script>\n<script src="sleep-state-guard.js?v=1.0.0-sleep2"></script>\n<script src="recording-bridge.js?v=1.0.0-continuity2"></script>\n<script src="event-channel.js?v=1.0.0-events1"></script>\n<script src="ota.js?v=1.0.0-ota4"></script>\n<script src="releases.js?v=1.0.0-prod2"></script>\n<script src="app.js?v=1.0.0-arch1"></script>\n<script src="enhancements.js?v=1.0.0-arch1"></script>\n<script src="google-auth.js?v=1.0.0-brain1"></script>\n<script src="ai-providers.js?v=1.0.0-brain1"></script>\n<script src="synap-backend.js?v=1.0.0-pipeline1"></script>\n<script src="processing-pipeline-ui.js?v=1.0.0-pipeline1"></script>\n<script src="memory-ui-fix.js?v=1.0.0-arch1"></script>\n<script src="synap-account-ui.js?v=1.0.0-brain1"></script>\n<script src="people-confirm-ui.js?v=1.0.0-people1"></script>\n<script src="cloud-history.js?v=1.0.0-history2"></script>\n<script src="memory-tools.js?v=1.0.0-transcript4"></script>\n<script src="cost-ui.js?v=1.0.0-cost2"></script>\n<script src="transcript-repair.js?v=1.0.0-transcript2"></script>\n<script src="voice-profile.js?v=1.0.0-voice-profile2"></script>\n<script src="ask-synap.js?v=1.0.0-ask2"></script>\n<script src="brain-ui.js?v=1.0.0-actions2"></script>\n<script src="dashboard-ui.js?v=1.0.0-dashboard2"></script>\n<script src="runtime-ui.js?v=1.0.0-runtime4"></script>\n<script src="capture-ui.js?v=1.0.0-capture2"></script>\n<script src="product-ui.js?v=1.0.0-product2"></script>`;

  s=replaceRegexOnce(s,
    /<script src="runtime-compat\.js\?[^\"]+"><\/script>[\s\S]*?<script src="cloud-history\.js\?[^\"]+"><\/script>/g,
    runtime,
    'deterministic runtime script graph');
  return s;
}

function patchApp(source){
  let s=source;
  s=replaceOnce(s,
    '  const MAX_AUTO_RECONNECT_ATTEMPTS = 3;',
    '  const AUTO_RECONNECT_DELAYS_MS = [1200, 2600, 5200, 10000, 15000, 20000, 30000, 30000];\n  const MAX_AUTO_RECONNECT_ATTEMPTS = AUTO_RECONNECT_DELAYS_MS.length;',
    'reconnect horizon');
  s=replaceOnce(s,
    '    const delays = [1200, 2600, 5200];\n    const attempt = reconnectAttempts + 1;\n    const wait = delays[reconnectAttempts];',
    '    const attempt = reconnectAttempts + 1;\n    const wait = AUTO_RECONNECT_DELAYS_MS[reconnectAttempts];',
    'reconnect delay table');
  return s;
}

function patchBattery(source){
  let s=source;
  s=replaceOnce(s,
    'function tryAutoStart(){if(!autoStartPending)return;',
    'function tryAutoStart(){if(root.SynapRecordingBridge)return;if(!autoStartPending)return;',
    'single hardware stream adoption owner');
  s=replaceOnce(s,
    "if(document.querySelector('script[data-synap-memory-tools]'))return;",
    "if(root.SYNAP_STATIC_BOOTSTRAP||document.querySelector('script[data-synap-memory-tools]'))return;",
    'disable dynamic memory tools under static bootstrap');
  s=replaceOnce(s,
    "if(document.querySelector('script[data-synap-voice-profile]'))return;",
    "if(root.SYNAP_STATIC_BOOTSTRAP||document.querySelector('script[data-synap-voice-profile]'))return;",
    'disable dynamic voice profile under static bootstrap');
  return s;
}

function patchCloudHistory(source){
  let s=source;
  s=replaceOnce(s,
    '  function loadTranscriptRepair() {\n    if (!root.document || root.SynapTranscriptRepair ||',
    '  function loadTranscriptRepair() {\n    if (root.SYNAP_STATIC_BOOTSTRAP) return;\n    if (!root.document || root.SynapTranscriptRepair ||',
    'static transcript repair');
  s=replaceOnce(s,
    '  function loadProductRuntime() {\n    loadRuntimeModule(',
    '  function loadProductRuntime() {\n    if (root.SYNAP_STATIC_BOOTSTRAP) return;\n    loadRuntimeModule(',
    'static product runtime');
  return s;
}

function patchRuntimeUi(source){
  return replaceOnce(source,
    '  function init(){bindSettingsBrand();bindFirmwareAffordance();bindTouchRecordingBridge();bindRecordingControls();bindTapResponsiveness();bindBrainTabs();bindReducedMotion()}',
    '  function init(){bindSettingsBrand();bindFirmwareAffordance();if(!globalThis.SynapRecordingBridge)bindTouchRecordingBridge();bindRecordingControls();bindTapResponsiveness();if(!globalThis.SynapDashboardUI)bindBrainTabs();bindReducedMotion()}',
    'single runtime owners');
}

function patchCaptureUi(source){
  return replaceOnce(source,
    "    if(timer)new MutationObserver(sync).observe(timer,{childList:true,subtree:true,characterData:true});",
    "    if(timer)new MutationObserver(()=>{if(RECORDING_STATES.has(document.body.dataset.state||''))toggle.dataset.time=timer.textContent||''}).observe(timer,{childList:true,subtree:true,characterData:true});",
    'timer-only capture update');
}

function patchSleepGuard(source){
  let s=source;
  s=replaceOnce(s,
    "  function beginSleepLock(){\n    if(!locked()){\n      set(SAVED_RECONNECT_KEY,currentReconnectPreference());\n      set(SLEEP_STATE_KEY,'1');\n    }\n    forceReconnectOff();\n  }",
    "  function beginSleepLock(){\n    const alreadyLocked=locked();\n    if(!alreadyLocked){\n      set(SAVED_RECONNECT_KEY,currentReconnectPreference());\n      set(SLEEP_STATE_KEY,'1');\n    }\n    forceReconnectOff();\n    if(!alreadyLocked)root.dispatchEvent?.(new CustomEvent('synap-intentional-sleep',{detail:{active:true,owner:'sleep-state-guard'}}));\n  }",
    'sleep owner active event');
  s=replaceOnce(s,
    "    const checkbox=document.getElementById('autoReconnectInput');\n    if(checkbox)checkbox.checked=previous!=='off';\n  }",
    "    const checkbox=document.getElementById('autoReconnectInput');\n    if(checkbox)checkbox.checked=previous!=='off';\n    root.dispatchEvent?.(new CustomEvent('synap-intentional-sleep',{detail:{active:false,owner:'sleep-state-guard'}}));\n  }",
    'sleep owner wake event');
  return s;
}

function patchRecordingBridge(source){
  let s=source;
  s=replaceOnce(s,
    "    root.addEventListener('synap-event-packet', handlePowerEvent);\n    root.addEventListener('synap-gatt-service-ready', () => {",
    "    if(!root.SynapSleepStateGuard) root.addEventListener('synap-event-packet', handlePowerEvent);\n    root.addEventListener('synap-intentional-sleep', event => {\n      intentionalSleep=Boolean(event?.detail?.active);\n      if(intentionalSleep){clearReconnectRestoreTimer();clearRolloverTimer();clearHardwareAdoptTimer();startingFromHardware=false;}\n      else handleDeviceState();\n    });\n    root.addEventListener('synap-gatt-service-ready', () => {",
    'sleep guard handoff');
  s=replaceOnce(s,
    "    root.addEventListener('pagehide', () => {\n      if (intentionalSleep) endIntentionalSleep();\n    });",
    "    if(!root.SynapSleepStateGuard) root.addEventListener('pagehide', () => {\n      if (intentionalSleep) endIntentionalSleep();\n    });",
    'persist intentional sleep across pagehide');
  return s;
}

function patchBrain(source){
  return replaceOnce(source,
    "    if(root.MutationObserver){\n      new root.MutationObserver(()=>setTimeout(refresh,100)).observe($('#insightsList')||document.body,{childList:true,subtree:true});\n    }",
    "    let refreshTimer=0;\n    const scheduleRefresh=()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,80)};\n    ['synap-cloud-history-updated','synap-memory-ready','synap-transcript-updated'].forEach(name=>root.addEventListener(name,scheduleRefresh));",
    'brain explicit data events');
}

function patchEnhancements(source){
  return replaceRegexOnce(source,
    /function bindBrief\(\)\{document\.getElementById\('datePicker'\)\?\.addEventListener\('change',[\s\S]*?\}\)\}/g,
    "function bindBrief(){let timer=0;const schedule=()=>{clearTimeout(timer);timer=setTimeout(refreshDayBrief,60)};document.getElementById('datePicker')?.addEventListener('change',schedule);document.getElementById('dateStrip')?.addEventListener('click',schedule);['synap-cloud-history-updated','synap-memory-ready','synap-transcript-updated'].forEach(name=>addEventListener(name,schedule))}",
    'brief explicit data events');
}

function patchDashboard(source){
  return replaceOnce(source,
    "  function init(){injectStyle();scan();let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;scan()})}).observe(document.body,{childList:true,subtree:true});}",
    "  function init(){injectStyle();scan();let queued=false;const schedule=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;scan()})};['synap-cloud-history-updated','synap-memory-ready','synap-processing-state','synap-transcript-updated'].forEach(name=>addEventListener(name,schedule));setTimeout(schedule,250);}",
    'dashboard explicit lifecycle');
}

function patchProduct(source){
  return replaceRegexOnce(source,
    /function simplifySettings\(\)\{[\s\S]*?\}\nfunction makeOverflow/g,
    "function simplifySettings(){const form=$('settingsForm');if(!form)return;labelCheckbox('autoProcessInput','Create memories automatically');labelCheckbox('wakeLockInput','Keep screen awake while listening');labelCheckbox('autoReconnectInput','Reconnect automatically');const oldHint=$('appearanceAutoHint');if(oldHint)oldHint.remove();for(const id of ['retrySaveButton','recoveryButton','runQueueButton','pauseQueueButton']){const el=$(id);if(el){el.hidden=true;el.setAttribute('aria-hidden','true')}}const processing=$('processing');if(processing)processing.hidden=true;renameButtons(form)}\nfunction makeOverflow",
    'remove Advanced and recovery product section');
}

function patchCaptureStability(source){
  return replaceRegexOnce(source,
    /  function hideLowLevelRecoveryUi\(\) \{[\s\S]*?\n  \}\n\n  function init\(\)/g,
    "  function hideLowLevelRecoveryUi() {\n    const styleId='synap-hide-low-level-recovery';\n    if(!root.document?.getElementById?.(styleId)){const style=root.document.createElement('style');style.id=styleId;style.textContent='#advancedSettings,.product-advanced,#retrySaveButton,#recoveryButton,#runQueueButton,#pauseQueueButton{display:none!important}';root.document.head?.appendChild(style)}\n    ['retrySaveButton','recoveryButton','runQueueButton','pauseQueueButton'].forEach(id=>{const node=root.document?.getElementById?.(id);if(node){node.hidden=true;node.setAttribute('aria-hidden','true')}});\n  }\n\n  function init()",
    'remove body-wide recovery observer');
}

function patchServiceWorker(source){
  return replaceOnce(source,
    "const CACHE_REVISION='1.0.0-shell35-ble-stability';",
    "const CACHE_REVISION='1.0.0-shell36-architecture';",
    'service worker architecture revision');
}

function patchReconnectTest(source){
  return replaceOnce(source,
    "assert.equal(reply.shellRevision,'1.0.0-shell35-ble-stability');",
    "assert.equal(reply.shellRevision,'1.0.0-shell36-architecture');",
    'worker revision expectation');
}

function main(){
  const patches={
    'index.html':patchIndex,
    'app.js':patchApp,
    'battery-popover-fix.js':patchBattery,
    'cloud-history.js':patchCloudHistory,
    'runtime-ui.js':patchRuntimeUi,
    'capture-ui.js':patchCaptureUi,
    'sleep-state-guard.js':patchSleepGuard,
    'recording-bridge.js':patchRecordingBridge,
    'brain-ui.js':patchBrain,
    'enhancements.js':patchEnhancements,
    'dashboard-ui.js':patchDashboard,
    'product-ui.js':patchProduct,
    'capture-stability.js':patchCaptureStability,
    'sw.js':patchServiceWorker,
    'tests/reconnect.cjs':patchReconnectTest,
  };
  for(const [file,patch] of Object.entries(patches))write(file,patch(read(file)));
}

if(require.main===module)main();
module.exports={patchIndex,patchApp,patchBattery,patchCloudHistory,patchRuntimeUi,patchCaptureUi,patchSleepGuard,patchRecordingBridge,patchBrain,patchEnhancements,patchDashboard,patchProduct,patchCaptureStability,patchServiceWorker};
