/* Synap desktop meeting/call capture: system/tab audio + microphone into the same local journal. */
(function(root){
'use strict';
const TARGET_RATE=16000,FRAME_SAMPLES=800,FRAME_BYTES=1600;
let session=null;
function supported(){return Boolean(root.navigator?.mediaDevices?.getDisplayMedia&&root.navigator?.mediaDevices?.getUserMedia&&(root.AudioContext||root.webkitAudioContext)&&root.DKAudioStore)}
function downsample(input,inputRate,state){if(inputRate===TARGET_RATE)return Float32Array.from(input);const ratio=inputRate/TARGET_RATE,out=[];let pos=state.pos||0;while(pos<input.length){const i=Math.floor(pos),j=Math.min(input.length-1,i+1),f=pos-i;out.push(input[i]*(1-f)+input[j]*f);pos+=ratio}state.pos=pos-input.length;return Float32Array.from(out)}
function pcm16(samples){const out=new Uint8Array(samples.length*2),v=new DataView(out.buffer);for(let i=0;i<samples.length;i++){const x=Math.max(-1,Math.min(1,samples[i]));v.setInt16(i*2,x<0?x*32768:x*32767,true)}return out}
function autoProcessEnabled(){try{return JSON.parse(root.localStorage?.getItem('dk-pendant-settings')||'{}').autoProcess===true}catch(_){return false}}
function setStatus(message){const el=document.getElementById('synapDesktopCaptureStatus');if(el)el.textContent=message||''}
function emitError(error){const message=error?.message||String(error||'Desktop capture failed.');console.warn('[synap desktop capture]',error);setStatus(message);root.dispatchEvent?.(new CustomEvent('synap-desktop-capture-error',{detail:{message}}))}
function cleanupResources(resources){if(!resources)return;try{resources.display?.getTracks?.().forEach(t=>t.stop())}catch(_){}try{resources.mic?.getTracks?.().forEach(t=>t.stop())}catch(_){}try{resources.processor?.disconnect?.()}catch(_){}try{resources.systemSource?.disconnect?.()}catch(_){}try{resources.micSource?.disconnect?.()}catch(_){}try{resources.destination?.disconnect?.()}catch(_){}if(resources.context&&resources.context.state!=='closed')Promise.resolve(resources.context.close()).catch(()=>{})}
function pendantBusy(){const state=String(document.body?.dataset?.state||'');return document.body?.dataset?.recordingInterrupted==='true'||['starting','recording','stopping','saving','updating'].includes(state)}
function localDayKey(value){const date=value instanceof Date?value:new Date(value);if(Number.isNaN(date.getTime()))return'';return[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-')}
function revealSavedRecording(recordingId,saved){
  const createdAt=saved?.createdAt||saved?.startedAt||new Date().toISOString();
  const day=localDayKey(createdAt),picker=document.getElementById('datePicker');
  if(picker&&day){picker.value=day;picker.dispatchEvent(new Event('change',{bubbles:true}))}
  try{root.location.hash='#library'}catch(_){}
  let attempts=0;
  const reveal=()=>{
    const card=document.getElementById('recording-'+recordingId);
    if(card){
      card.open=true;
      try{card.scrollIntoView({behavior:'smooth',block:'start'})}catch(_){}
      return;
    }
    attempts+=1;
    if(attempts<8)root.setTimeout(reveal,60);
  };
  root.setTimeout(reveal,0);
}
async function start(options={}){
  if(session)throw new Error('Desktop capture is already running.');
  if(pendantBusy())throw new Error('Finish or save the pendant recording before starting an online meeting capture.');
  if(!supported())throw new Error('Desktop meeting capture is not supported in this browser.');
  let display=null,mic=null,context=null,processor=null,systemSource=null,micSource=null,destination=null,journal=null,recordingId=null;
  try{
    display=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
    mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    const displayAudio=display.getAudioTracks();
    if(!displayAudio.length)throw new Error('Share a tab/window with audio enabled. No meeting audio was provided.');
    const Ctx=root.AudioContext||root.webkitAudioContext;
    context=new Ctx({sampleRate:TARGET_RATE});
    destination=context.createGain();destination.gain.value=0;destination.connect(context.destination);
    processor=context.createScriptProcessor(4096,2,1);
    systemSource=context.createMediaStreamSource(new MediaStream(displayAudio));
    micSource=context.createMediaStreamSource(mic);
    const systemGain=context.createGain(),micGain=context.createGain();systemGain.gain.value=.7;micGain.gain.value=.65;
    systemSource.connect(systemGain).connect(processor);micSource.connect(micGain).connect(processor);processor.connect(destination);
    journal=new root.DKAudioStore({onError:error=>{emitError(error);if(session?.journal===journal)stop('storage-error').catch(()=>{})}});
    await journal.open();
    const name=options.name||('Online meeting · '+new Date().toLocaleString([],{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}));
    recordingId=await journal.begin(name,{deviceId:'desktop-browser',associationId:'desktop-browser',installationId:null});
    await journal.atomic(['recordings'],stores=>{const q=stores.recordings.get(recordingId);q.onsuccess=()=>{if(q.result)stores.recordings.put({...q.result,captureSource:'desktop-meeting',captureMode:'system+microphone',desktopCapture:true})}});
    const pending=[],resample={pos:0};let sequence=0,stopping=false;
    const state={recordingId,journal,context,processor,systemSource,micSource,destination,display,mic,pending,resample,get sequence(){return sequence},set sequence(v){sequence=v},get stopping(){return stopping},set stopping(v){stopping=v}};
    session=state;
    processor.onaudioprocess=e=>{
      if(stopping||session!==state)return;
      try{
        const channels=e.inputBuffer.numberOfChannels,a=e.inputBuffer.getChannelData(0),b=channels>1?e.inputBuffer.getChannelData(1):null,mix=new Float32Array(a.length);
        for(let i=0;i<a.length;i++)mix[i]=b?(a[i]+b[i])*.5:a[i];
        const samples=downsample(mix,context.sampleRate,resample);for(const x of samples)pending.push(x);
        while(pending.length>=FRAME_SAMPLES){const frame=pcm16(pending.splice(0,FRAME_SAMPLES));journal.append(recordingId,{sequence:sequence++,chunk:0,total:1,payload:frame})}
      }catch(error){emitError(error);stop('capture-error').catch(()=>{})}
    };
    display.getTracks().forEach(track=>track.addEventListener('ended',()=>{if(session===state)stop('display-share-ended').catch(()=>{})},{once:true}));
    setStatus('Capturing meeting audio + microphone');
    root.dispatchEvent?.(new CustomEvent('synap-desktop-capture-started',{detail:{recordingId}}));
    syncButton();
    return{recordingId,name};
  }catch(error){
    if(recordingId&&journal){try{await journal.remove(recordingId)}catch(_){}}
    cleanupResources({display,mic,context,processor,systemSource,micSource,destination});
    throw error;
  }
}
async function stop(reason='desktop-capture'){
  const s=session;if(!s)return null;session=null;s.stopping=true;
  try{
    s.processor.onaudioprocess=null;
    if(s.pending.length){while(s.pending.length<FRAME_SAMPLES)s.pending.push(0);s.journal.append(s.recordingId,{sequence:s.sequence++,chunk:0,total:1,payload:pcm16(s.pending.splice(0,FRAME_SAMPLES))})}
    const saved=await s.journal.close(s.recordingId,reason);
    setStatus(saved?.durationMs?'Meeting saved in Library':'No complete meeting audio was captured');
    if(saved?.durationMs)revealSavedRecording(s.recordingId,saved);
    root.SynapProcessingPipeline?.refresh?.();
    root.SynapProductivity?.refresh?.(false);
    root.SynapInteractionSurfaces?.refresh?.(false);
    if(autoProcessEnabled())Promise.resolve(root.SynapProcessingQueue?.resume?.()).catch(()=>{});
    root.dispatchEvent?.(new CustomEvent('synap-recording-saved',{detail:{recordingId:s.recordingId,source:'desktop-meeting',reason,createdAt:saved?.createdAt||null,durationMs:saved?.durationMs||0}}));
    return s.recordingId;
  }catch(error){emitError(error);throw error}
  finally{cleanupResources(s);syncButton()}
}
function state(){return session?{active:true,recordingId:session.recordingId}:{active:false,recordingId:null}}
function syncButton(){const button=document.getElementById('synapDesktopCaptureButton');if(!button)return;button.textContent=session?'Stop meeting':'Capture meeting';button.dataset.active=String(Boolean(session));button.disabled=!session&&pendantBusy()}
function install(){if(!supported()||document.getElementById('synapDesktopCapture'))return;const capture=document.getElementById('capture');if(!capture)return;const box=document.createElement('div');box.id='synapDesktopCapture';box.className='desktop-capture-card';box.innerHTML='<div><strong>Online meeting</strong><small>Capture this computer’s meeting audio + your microphone. No bot joins the call.</small><small id="synapDesktopCaptureStatus" role="status"></small></div><button type="button" id="synapDesktopCaptureButton">Capture meeting</button>';const style=document.createElement('style');style.textContent='.desktop-capture-card{margin-top:12px;padding:11px 12px;border:1px solid var(--border,#d9e2ec);border-radius:14px;display:flex;gap:10px;align-items:center;justify-content:space-between;background:var(--surface,#fff)}.desktop-capture-card strong,.desktop-capture-card small{display:block}.desktop-capture-card small{margin-top:3px;font-size:10px;color:var(--muted,#64748b)}.desktop-capture-card button{border:0;border-radius:10px;padding:8px 11px;font:inherit;font-size:11px;font-weight:800;background:#102744;color:#fff;cursor:pointer}.desktop-capture-card button[data-active="true"]{background:#9f1d35}.desktop-capture-card button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:560px){.desktop-capture-card{display:none}}';document.head.appendChild(style);capture.appendChild(box);const button=document.getElementById('synapDesktopCaptureButton');button.addEventListener('click',async()=>{button.disabled=true;try{if(session)await stop();else await start()}catch(error){emitError(error)}finally{syncButton()}});new MutationObserver(syncButton).observe(document.body,{attributes:true,attributeFilter:['data-state','data-recording-interrupted']});syncButton()}
root.SynapDesktopCapture={supported,start,stop,state,TARGET_RATE,FRAME_SAMPLES,FRAME_BYTES,autoProcessEnabled,pendantBusy,localDayKey,revealSavedRecording};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(globalThis);