/* Keep the clickable battery details fully visible on mobile/Bluefy viewports. */
(function(root){'use strict';
function style(){if(document.getElementById('synapBatteryViewportFix'))return;const s=document.createElement('style');s.id='synapBatteryViewportFix';s.textContent=`
#synapBatteryPopover{box-sizing:border-box;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;overscroll-behavior:contain}
@media(max-width:560px){#synapBatteryPopover{left:12px!important;right:12px!important;top:auto!important;bottom:max(12px,env(safe-area-inset-bottom))!important;width:auto!important;max-width:none!important;max-height:min(72dvh,560px);border-radius:20px;padding-bottom:max(16px,calc(12px + env(safe-area-inset-bottom)));}}
`;document.head.appendChild(s)}
function place(){style();const pop=document.getElementById('synapBatteryPopover'),button=document.getElementById('headerBatteryStatus');if(!pop||pop.hidden||!button)return;const vv=root.visualViewport,w=vv?.width||root.innerWidth,h=vv?.height||root.innerHeight,ox=vv?.offsetLeft||0,oy=vv?.offsetTop||0,margin=12;if(w<=560){pop.style.left=margin+'px';pop.style.right=margin+'px';pop.style.top='auto';pop.style.bottom=Math.max(margin,Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('env(safe-area-inset-bottom)'))||margin)+'px';return;}const r=button.getBoundingClientRect();const pw=Math.min(pop.offsetWidth,w-2*margin),ph=Math.min(pop.offsetHeight,h-2*margin);let left=r.right-pw,top=r.bottom+8;if(top+ph>oy+h-margin)top=r.top-ph-8;left=Math.max(ox+margin,Math.min(left,ox+w-pw-margin));top=Math.max(oy+margin,Math.min(top,oy+h-ph-margin));pop.style.right='auto';pop.style.bottom='auto';pop.style.left=Math.round(left)+'px';pop.style.top=Math.round(top)+'px'}
function schedule(){requestAnimationFrame(()=>requestAnimationFrame(place))}
document.addEventListener('click',e=>{if(e.target?.closest?.('#headerBatteryStatus'))schedule()},true);root.addEventListener('resize',schedule);root.visualViewport?.addEventListener('resize',schedule);root.visualViewport?.addEventListener('scroll',schedule);document.addEventListener('DOMContentLoaded',style,{once:true});if(document.readyState!=='loading')style();
})(globalThis);

/* Rolling transcription bridge.
 *
 * Storage remains one logical recording for the complete meeting. The journal's
 * existing 30-second PCM segments are processing windows only: when a window
 * closes we compact it, queue its upload/transcription job and immediately wake
 * the processor. DKAudioStore.blob(record) still rebuilds one full-duration WAV.
 */
(function(root){'use strict';
const WINDOW_FRAMES=600; // 30 s at 50 ms/frame; must match audio-store.js.
let installAttempts=0;

function providerIsSynap(){
  try{const value=JSON.parse(root.localStorage?.getItem('synap-ai-provider-settings')||'{}');return String(value.provider||'synap')==='synap';}
  catch(_){return true;}
}
function signedIn(){try{return Boolean(root.SynapAuth?.isSignedIn?.());}catch(_){return false;}}
function kickProcessor(){
  if(!providerIsSynap()||!signedIn())return;
  const button=root.document?.getElementById('runQueueButton');
  if(button&&!button.disabled)button.click();
}
function install(){
  const Store=root.DKAudioStore,codec=root.DKAudioCodec;
  if(!Store||!codec?.assemble)return false;
  if(Store.prototype.__synapRollingTranscription)return true;
  const originalBegin=Store.prototype.begin;
  const originalAppend=Store.prototype.append;
  const originalClose=Store.prototype.close;

  Store.prototype.begin=async function(name,association){
    const id=await originalBegin.call(this,name,association);
    try{
      const session=root.SynapAuth?.session?.();
      const uid=String(session?.profile?.uid||'')||null;
      await this.atomic(['recordings'],stores=>{
        const request=stores.recordings.get(id);
        request.onsuccess=()=>{if(request.result)stores.recordings.put({...request.result,ownerUid:uid,rollingTranscription:true,transcriptionWindowSeconds:30});};
      });
    }catch(_){}
    return id;
  };

  function sealWindow(store,recordingId,index){
    if(!Number.isInteger(index)||index<0)return;
    store.__synapRollingSeal=(store.__synapRollingSeal||Promise.resolve()).then(async()=>{
      await store.flush();
      const meta=await store.get('segments',[recordingId,index]);
      if(meta?.pcmBlob){kickProcessor();return;}
      const packets=await store.all('packets','segment',[recordingId,index]);
      if(!packets.length)return;
      const start=index*WINDOW_FRAMES,end=start+WINDOW_FRAMES-1;
      const data=codec.assemble(packets,{preserveTimeline:true,startSequence:start,endSequence:end});
      if(!data.completeFrames)return;
      await store.compactSegment(recordingId,index,data);
      root.dispatchEvent(new CustomEvent('synap-transcription-window-ready',{detail:{recordingId,segmentIndex:index,startMs:index*30000,endMs:(index+1)*30000}}));
      kickProcessor();
    }).catch(error=>{try{store.onError(error)}catch(_){}});
  }

  Store.prototype.append=function(recordingId,packet){
    originalAppend.call(this,recordingId,packet);
    const index=Math.floor(packet.sequence/WINDOW_FRAMES);
    this.__synapRollingIndex=this.__synapRollingIndex||new Map();
    const previous=this.__synapRollingIndex.get(recordingId);
    if(Number.isInteger(previous)&&index>previous)sealWindow(this,recordingId,previous);
    this.__synapRollingIndex.set(recordingId,index);
  };

  Store.prototype.close=async function(recordingId,reason){
    await(this.__synapRollingSeal||Promise.resolve());
    const saved=await originalClose.call(this,recordingId,reason);
    if(this.__synapRollingIndex)this.__synapRollingIndex.delete(recordingId);
    // close() seals the final partial 30-second window and creates the meeting
    // consolidate job; wake processing even if the last boundary was <30 sec.
    kickProcessor();
    return saved;
  };

  Store.prototype.__synapRollingTranscription=true;
  return true;
}

if(!install()){
  const timer=root.setInterval(()=>{if(install()||++installAttempts>400)root.clearInterval(timer)},40);
}
})(globalThis);

/* Pendant power-lifecycle bridge.
 *
 * The existing app.js protocol only accepts control-status states 0..3, so
 * firmware standby remains internally CONNECTED_IDLE. This bridge uses the
 * already-defined CMD_STANDBY command after a quiet idle window and listens to
 * retained async power events. A deep-sleep double tap sets WAKE_RECORD; once
 * normal app connection setup reaches idle, the existing Start button is invoked
 * so journal/subscription/wake-lock behavior stays owned by app.js.
 */
(function(root){'use strict';
const CONTROL_UUID='4fa12347-0000-1000-8000-00805f9b34fb';
const PROTOCOL_VERSION=0x02,CMD_STANDBY=0x03;
const POWER_MAGIC=0xE2,POWER_VERSION=1,POWER_AWAKE=1,POWER_STANDBY=2,POWER_DEEP_SLEEP=3,POWER_WAKE_RECORD=4;
const IDLE_TO_STANDBY_MS=30000;
let service=null,control=null,standbyTimer=0,autoStartPending=false,lastPowerState=0,writeBusy=false,stateObserver=null;

function state(){return String(document.body?.dataset?.state||'')}
function cancelStandby(){if(standbyTimer){clearTimeout(standbyTimer);standbyTimer=0}}
function eligibleIdle(){return state()==='idle'&&document.body?.dataset?.deviceState==='1'&&!writeBusy}
async function getControl(){if(control)return control;if(!service?.getCharacteristic)return null;control=await service.getCharacteristic(CONTROL_UUID);return control}
async function writeStandby(){
  standbyTimer=0;
  if(!eligibleIdle()||lastPowerState===POWER_STANDBY)return;
  writeBusy=true;
  try{
    const c=await getControl();if(!c||state()!=='idle')return;
    const payload=new Uint8Array([CMD_STANDBY,PROTOCOL_VERSION]);
    if(c.properties?.write&&typeof c.writeValueWithResponse==='function')await c.writeValueWithResponse(payload);
    else if(c.properties?.writeWithoutResponse&&typeof c.writeValueWithoutResponse==='function')await c.writeValueWithoutResponse(payload);
    else await c.writeValue(payload);
    document.body.dataset.powerState='standby';
  }catch(error){
    console.warn('[synap power] standby command failed',error);
    if(state()==='idle')standbyTimer=setTimeout(writeStandby,10000);
  }finally{writeBusy=false}
}
function scheduleStandby(){
  cancelStandby();
  if(!service||state()!=='idle'||lastPowerState===POWER_STANDBY)return;
  standbyTimer=setTimeout(writeStandby,IDLE_TO_STANDBY_MS);
}
function tryAutoStart(){
  if(!autoStartPending)return;
  const button=document.getElementById('startButton');
  if(state()!=='idle'||!button||button.disabled)return;
  autoStartPending=false;
  document.body.dataset.powerIntent='';
  setTimeout(()=>{if(state()==='idle'&&!button.disabled)button.click()},80);
}
function onStateChange(){const s=state();if(s==='idle'){tryAutoStart();scheduleStandby()}else cancelStandby()}
function bindStateObserver(){
  if(stateObserver||!root.MutationObserver||!document.body)return;
  stateObserver=new MutationObserver(onStateChange);
  stateObserver.observe(document.body,{attributes:true,attributeFilter:['data-state','data-device-state']});
  onStateChange();
}
function parseHex(hex){return String(hex||'').trim().split(/\s+/).filter(Boolean).map(x=>Number.parseInt(x,16))}
function onPowerPacket(event){
  const bytes=parseHex(event?.detail?.hex);if(bytes.length!==6||bytes[0]!==POWER_MAGIC||bytes[1]!==POWER_VERSION)return;
  lastPowerState=bytes[2];document.body.dataset.powerState=lastPowerState===POWER_STANDBY?'standby':lastPowerState===POWER_DEEP_SLEEP?'deep-sleep':'awake';
  if(lastPowerState===POWER_WAKE_RECORD){autoStartPending=true;document.body.dataset.powerIntent='record';tryAutoStart()}
  if(lastPowerState===POWER_AWAKE||lastPowerState===POWER_WAKE_RECORD)scheduleStandby();
}
root.addEventListener('synap-event-packet',onPowerPacket);
root.addEventListener('synap-gatt-service-ready',event=>{service=event?.detail?.service||root.__synapGattService||null;control=null;lastPowerState=0;bindStateObserver();scheduleStandby();setTimeout(tryAutoStart,900)});
if(document.body)bindStateObserver();else document.addEventListener('DOMContentLoaded',bindStateObserver,{once:true});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){bindStateObserver();tryAutoStart();scheduleStandby()}});
root.SynapPowerLifecycle={IDLE_TO_STANDBY_MS,get state(){return lastPowerState},get autoStartPending(){return autoStartPending},schedule:scheduleStandby};
})(globalThis);
