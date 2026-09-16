/* Storage/service health, pendant diagnostics and diagnostic exports. */
(function(){'use strict';const SHELL_REVISION='1.0.0-shell124-chakshu',DIAGNOSTICS_UUID='4fa1234d-0000-1000-8000-00805f9b34fb',riskyStates=new Set(['recording','starting','stopping','saving','updating']),resetReasons={0:'Unknown',1:'Power on',2:'External reset',3:'Software reset',4:'Panic',5:'Interrupt watchdog',6:'Task watchdog',7:'Watchdog',8:'Deep sleep',9:'Brownout',10:'SDIO reset',11:'USB reset',12:'JTAG reset',13:'eFuse reset',14:'Power glitch',15:'CPU lockup'};let lastPendantDiagnostic='',diagnosticsPending=false;const formatBytes=n=>{if(!n)return'0 B';const u=['B','KB','MB','GB'],i=Math.min(u.length-1,Math.floor(Math.log(n)/Math.log(1024)));return(n/1024**i).toFixed(i?1:0)+' '+u[i]},formatDuration=s=>{s=Math.max(0,Number(s)||0);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h?`${h}h ${m}m`:`${m}m`};function injectStyles(){const s=document.createElement('style');s.textContent='.system-health-body{display:grid;gap:.65rem;padding-top:.5rem}.system-health-row{display:flex;justify-content:space-between;gap:1rem}.system-health-row span{opacity:.68}.system-health-row strong{text-align:right;font-weight:650;max-width:68%}.system-health-warning{font-size:.82rem;line-height:1.4;margin:0;opacity:.8}.update-reload{margin-left:.65rem}';document.head.appendChild(s)}function injectSystemHealth(){const diagnostics=document.getElementById('diagnostics');if(!diagnostics||document.getElementById('systemHealth'))return;const d=document.createElement('details');d.id='systemHealth';d.className='settings-card';d.innerHTML='<summary class="settings-card-head"><span class="settings-icon"><svg aria-hidden="true"><use href="#i-library"/></svg></span><span class="settings-heading"><strong>App &amp; storage</strong></span><svg class="disclosure-chevron" aria-hidden="true"><use href="#i-chevron"/></svg></summary><div class="system-health-body"><div class="system-health-row"><span>Pendant health</span><strong id="pendantHealth">Not connected</strong></div><div class="system-health-row"><span>Browser storage</span><strong id="storageHealth">Checking…</strong></div><div class="system-health-row"><span>Offline app</span><strong id="serviceHealth">Checking…</strong></div><div class="system-health-row"><span>Network</span><strong id="networkHealth">—</strong></div><p id="storageWarning" class="system-health-warning"></p></div>';diagnostics.insertAdjacentElement('beforebegin',d);const connection=document.getElementById('settingsConnectionHealth');if(connection)connection.append(d.querySelector('#pendantHealth').closest('.system-health-row'));d.addEventListener('toggle',()=>{if(d.open)refreshSystemHealth()})}function decodePendantDiagnostics(v) {
  if (!v || v.byteLength < 2 || v.getUint8(0) !== 0xD6 ||
      !((v.getUint8(1) === 1 && v.byteLength === 32) ||
        (v.getUint8(1) === 2 && v.byteLength === 48) ||
        (v.getUint8(1) === 3 && v.byteLength === 72) ||
        (v.getUint8(1) === 4 && v.byteLength === 84))) {
    throw new Error('Unsupported pendant diagnostics');
  }
  const flags = v.getUint8(2), reset = v.getUint8(3), u32 = o => v.getUint32(o, true);
  const data = {
    realMic: Boolean(flags & 1), connected: Boolean(flags & 2),
    firmwareDsp: v.getUint8(1) >= 2 && (flags & 0x40) ? 'none' : 'unknown',
    audioTransport: v.getUint8(1) >= 2 && (flags & 0x40) ? ((flags & 0x80) ? 'pcm16' : 'adpcm') : 'unknown',
    streaming: Boolean(flags & 4), otaBusy: Boolean(flags & 8),
    reset, resetText: resetReasons[reset] || `Reset ${reset}`,
    captured: u32(4), captureDrops: u32(8), notifyRejects: u32(12), controlDrops: u32(16),
    freeHeap: u32(20), minFreeHeap: u32(24), uptime: u32(28)
  };
  if (v.getUint8(1) >= 2) {
    data.disconnectReason = v.getUint16(32, true);
    data.notifyStatus = v.getUint16(34, true);
    data.disconnects = u32(36);
    data.lastDisconnectMs = u32(40);
    data.notifyError = u32(44);
    const reasons = {8: 'Link supervision timeout', 19: 'Remote host ended connection',
      22: 'Local host ended connection', 34: 'Link response timeout',
      59: 'Unacceptable connection parameters', 65535: 'Reason unavailable'};
    // NimBLE wraps HCI reasons in 0x200. Keep the raw value in the log and
    // decode only that namespace; host errors and ATT errors have other ranges.
    const hciReason = data.disconnectReason >= 0x200 && data.disconnectReason <= 0x2ff
      ? data.disconnectReason - 0x200 : data.disconnectReason;
    data.disconnectText = data.disconnects === 0 ? 'No disconnect since boot' :
      (reasons[hciReason] || `BLE reason 0x${data.disconnectReason.toString(16)}`);
  }
  if (v.getUint8(1) >= 3) {
    const stages = ['disconnected', 'connected', 'audio-subscribed', 'status-requested', 'streaming'];
    if (v.getUint8(66) >= stages.length || v.getUint8(67) >= stages.length)
      throw new Error('Unsupported pendant link stage');
    Object.assign(data, {
      bootReadyMs: u32(48), mediaBootMs: u32(52), lastLinkDurationMs: u32(56),
      lastLinkIntervalMs: v.getUint16(60, true) * 1.25,
      lastLinkLatency: v.getUint16(62, true),
      lastLinkSupervisionMs: v.getUint16(64, true) * 10,
      lastLinkStage: stages[v.getUint8(66)], linkStage: stages[v.getUint8(67)],
      linkDurationMs: u32(68),
    });
  }
  if (v.getUint8(1) === 4) {
    const code = offset => v.getUint16(offset, true) === 65535 ? null : v.getUint16(offset, true);
    Object.assign(data, {
      linkIntervalMs: v.getUint16(72, true) * 1.25,
      linkLatency: v.getUint16(74, true), linkSupervisionMs: v.getUint16(76, true) * 10,
      linkParamRequests: v.getUint8(78), lastLinkParamRequests: v.getUint8(79),
      // Native return code zero confirms submission only. linkSupervisionMs is
      // the actual GAP observation, including central rejection/replacement.
      linkParamRequestCode: code(80), lastLinkParamRequestCode: code(82),
    });
  }
  return data;
}
function appendPendantDiagnostic(data) {
  const summary = JSON.stringify(data);
  if (summary === lastPendantDiagnostic) return;
  lastPendantDiagnostic = summary;
  // Use the recorder's bounded log so Copy, Download and subsequent log writes
  // all retain the same firmware evidence.
  globalThis.dispatchEvent(new CustomEvent('synap-pendant-diagnostics', {detail: data}));
}
let linkDiagnosticTimer = null;
addEventListener('synap-gatt-ready', () => {
  clearTimeout(linkDiagnosticTimer);
  // One deferred snapshot per connection records the previous disconnect and
  // boot timings. The existing idle policy skips it if capture has begun.
  linkDiagnosticTimer = setTimeout(() => { linkDiagnosticTimer = null; readPendantDiagnostics(); }, 3000);
});
addEventListener('synap-gatt-disconnected', () => {
  clearTimeout(linkDiagnosticTimer); linkDiagnosticTimer = null;
});
async function readPendantDiagnostics(){
const target=document.getElementById('pendantHealth');if(!target||diagnosticsPending)return;
const available=()=>!riskyStates.has(document.body.dataset.state)&&document.body.dataset.state==='idle';
if(!available()){target.textContent=document.body.dataset.state==='recording'?'Available when recording stops':'Available when idle';return}
const current=globalThis.SynapDevices?.connection;if(!current){target.textContent='Not connected';return}
diagnosticsPending=true;
try{
const c=await current.queue(()=>available()?current.service.getCharacteristic(DIAGNOSTICS_UUID):null,'Find pendant diagnostics');
if(!c||!available())return;
const value=await current.queue(()=>available()?c.readValue():null,'Read pendant diagnostics');
if(!value||!available())return;
const data=decodePendantDiagnostics(value),drops=data.captureDrops+data.controlDrops,resetConcern=[4,5,6,7,9,14,15].includes(data.reset);
const health=resetConcern?'Last reset: '+data.resetText:data.disconnects?`${data.disconnectText} · ${data.disconnects} disconnects`:'Healthy';
target.textContent=`${health} · ${drops} drops · ${data.notifyRejects} notify rejects · ${formatBytes(data.freeHeap)} heap · ${formatDuration(data.uptime)}`;appendPendantDiagnostic(data);
}catch(error){if(globalThis.SynapDevices?.connection===current)target.textContent=error?.name==='NotFoundError'?'Available after firmware update':'Unable to read'}finally{diagnosticsPending=false}
}async function refreshSystemHealth(){const storage=document.getElementById('storageHealth'),service=document.getElementById('serviceHealth'),network=document.getElementById('networkHealth'),warning=document.getElementById('storageWarning');if(!storage)return;network.textContent=navigator.onLine?'Online':'Offline';service.textContent=navigator.serviceWorker?.controller?'Ready':'Installing / browser managed';readPendantDiagnostics();try{const estimate=await navigator.storage?.estimate?.(),persisted=await navigator.storage?.persisted?.();if(estimate?.quota){const ratio=(estimate.usage||0)/estimate.quota;storage.textContent=`${formatBytes(estimate.usage||0)} of ${formatBytes(estimate.quota)} · ${persisted?'protected':'evictable'}`;warning.textContent=ratio>=.85?'Storage is above 85%. Export or remove recordings before the browser runs out of space.':persisted?'Storage protection is enabled for this browser.':'The browser may evict local recordings under storage pressure.'}else{storage.textContent='Available';warning.textContent='Storage quota details are not exposed by this browser.'}}catch(e){storage.textContent='Unavailable';warning.textContent=e.message}}function injectDiagnosticsExport(){const actions=document.querySelector('#diagnostics .setting-actions');if(!actions||document.getElementById('downloadDiagnosticsButton'))return;const b=document.createElement('button');b.id='downloadDiagnosticsButton';b.type='button';b.className='text-button';b.textContent='Download log';b.addEventListener('click',()=>{const text=document.getElementById('diagnosticsLog')?.textContent||'',blob=new Blob([text],{type:'text/plain'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='synap-diagnostics-'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});actions.appendChild(b)}function maintainUpdateNotice() {
  const notice = document.getElementById('updateNotice');
  if (!notice) return;
  const safeToReload = () => !riskyStates.has(document.body.dataset.state) &&
    document.body.dataset.recordingInterrupted !== 'true' &&
    !globalThis.SynapDesktopCapture?.state()?.active &&
    globalThis.SynapAppControls?.canReload?.() === true;
  const render = () => {
    if (notice.hidden || !notice.textContent.includes('App update ready')) return;
    let button = notice.querySelector('.update-reload');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-secondary button-small update-reload';
      button.textContent = 'Reload';
      button.addEventListener('click', () => {
        // Recheck at the action boundary: a take can start before observers run.
        if (safeToReload()) location.reload();
        else render();
      });
      notice.appendChild(button);
    }
    button.disabled = !safeToReload();
    button.title = button.disabled ? 'Finish recording and save your audio before reloading.' : 'Reload the updated app';
  };
  new MutationObserver(render).observe(notice, {childList:true, subtree:true, attributes:true, attributeFilter:['hidden']});
  new MutationObserver(render).observe(document.body, {attributes:true, attributeFilter:['data-state','data-recording-interrupted']});
  for (const event of ['synap-desktop-capture-changed','synap-desktop-capture-started','synap-desktop-capture-stopped']) addEventListener(event, render);
  render();
  // app.js compares the worker with its own loaded revision. A newer copy of
  // this UI helper must not hide an update needed by an older recorder module.
}
document.addEventListener('click',e=>{if(e.target.closest?.('#settingsButton'))setTimeout(refreshSystemHealth,120)});addEventListener('online',refreshSystemHealth);addEventListener('offline',refreshSystemHealth);function init(){injectStyles();injectSystemHealth();injectDiagnosticsExport();maintainUpdateNotice();refreshSystemHealth()}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();globalThis.SynapEnhancements={decodePendantDiagnostics}})();
