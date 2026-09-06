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
