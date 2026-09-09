'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const write=(f,s)=>fs.writeFileSync(path.join(root,f),s);
function once(s,b,a,label){const i=s.indexOf(b);if(i<0)throw Error(`Missing finalization anchor: ${label}`);if(s.indexOf(b,i+b.length)>=0)throw Error(`Ambiguous finalization anchor: ${label}`);return s.slice(0,i)+a+s.slice(i+b.length)}
function regexOnce(s,re,a,label){const m=[...s.matchAll(re)];if(m.length!==1)throw Error(`${m.length?'Ambiguous':'Missing'} finalization anchor: ${label} (${m.length})`);return s.replace(re,a)}

let s=read('enhancements.js');
s=once(s,"const SHELL_REVISION='1.0.0-shell26-end-to-end-audio'","const SHELL_REVISION='1.0.0-shell36-architecture'",'enhancement shell generation');write('enhancements.js',s);

s=read('recording-bridge.js');
s=once(s,"      if (intentionalSleep) endIntentionalSleep();","      if (intentionalSleep && !root.SynapSleepStateGuard) endIntentionalSleep();",'guard owns wake restore');
s=once(s,"    if (intentionalSleep) scheduleReconnectPreferenceRestore();","    if (intentionalSleep && !root.SynapSleepStateGuard) scheduleReconnectPreferenceRestore();",'guard owns disconnected sleep lock');write('recording-bridge.js',s);

s=read('capture-ui.js');
s=regexOnce(s,/    \/\* Keep queue controls available in Settings[\s\S]*?\n    section\.classList\.add\('capture-minimal'\);/g,"    /* Processing is automatic/product-managed. Low-level queue controls stay internal. */\n    const processing=document.getElementById('processing');\n    if(processing)processing.hidden=true;\n\n    section.classList.add('capture-minimal');",'remove manual processing controls');
s=once(s,"    if(timer)new MutationObserver(sync).observe(timer,{childList:true,subtree:true,characterData:true});","    if(timer)new MutationObserver(()=>{if(RECORDING_STATES.has(document.body.dataset.state||''))toggle.dataset.time=timer.textContent||''}).observe(timer,{childList:true,subtree:true,characterData:true});",'timer-only header update');write('capture-ui.js',s);

s=read('tests/architecture-contract.cjs');
s=once(s,"const stability=read('capture-stability.js');","const stability=read('capture-stability.js');\nconst capture=read('capture-ui.js');",'capture contract import');
s=once(s,"assert.match(bridge,/root\\.addEventListener\\('synap-intentional-sleep'/,\n  'recording bridge should consume canonical sleep state rather than own reconnect preferences');","assert.match(bridge,/root\\.addEventListener\\('synap-intentional-sleep'/,\n  'recording bridge should consume canonical sleep state rather than own reconnect preferences');\nassert.match(bridge,/intentionalSleep && !root\\.SynapSleepStateGuard/,\n  'recording bridge must not restore reconnect preference when the sleep guard owns it');",'sleep handoff contract');
s=once(s,"assert.doesNotMatch(product,/Advanced & recovery/,'product UI must not recreate the removed Advanced & recovery panel');","assert.doesNotMatch(product,/Advanced & recovery/,'product UI must not recreate the removed Advanced & recovery panel');\nassert.doesNotMatch(capture,/backgroundMemoryControls/,'capture UI must not rebuild manual processing controls');\nassert.doesNotMatch(capture,/if\\(timer\\)new MutationObserver\\(sync\\)/,'recording timer must not trigger a full capture-header render every second');\nassert(enhancements.includes(\"SHELL_REVISION='1.0.0-shell36-architecture'\"),'update-notice generation must match the service worker');",'capture and generation contracts');write('tests/architecture-contract.cjs',s);
