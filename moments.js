/* Recording bookmarks share the journal's lifetime and audio timeline. */
(function(root){
  'use strict';
  let store,context;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function markers(recording){
    let legacy=[];try{legacy=JSON.parse(localStorage.getItem('synap-memory-highlights')||'[]')}catch(_){}
    const all=[...(recording.rememberMarkers||recording.highlights||[]),...(Array.isArray(legacy)?legacy.filter(m=>m.recordingId===recording.id&&Number.isFinite(m.offsetSeconds)).map(m=>({...m,offsetMs:m.offsetSeconds*1000})):[])];
    const unique=new Map();
    for(const m of all){
      const id=m.id||m.highlightId,offset=m.offsetMs??m.offset;
      if(!uuid.test(id)||!Number.isFinite(offset)||offset<0)continue;
      unique.set(id,{...m,id,offsetMs:Math.round(offset),source:m.source==='pendant'?'pendant':'pwa'});
    }
    return [...unique.values()].sort((a,b)=>a.offsetMs-b.offsetMs);
  }
  async function mark(detail={}){
    const current=context?.();
    if(!store||!current?.active||!current.recordingId)throw Error('Start recording before marking a moment.');
    const marker={id:crypto.randomUUID(),offsetMs:current.offsetMs,createdAt:new Date().toISOString(),source:detail.eventKey?'pendant':'pwa',...(detail.eventKey?{pendantEventKey:detail.eventKey,pendantStreamOffsetMs:Number.isFinite(detail.streamOffsetMs)?detail.streamOffsetMs:null}:{})};
    const added=await store.atomic(['recordings'],(s,done,tx)=>{
      const request=s.recordings.get(current.recordingId);
      request.onsuccess=()=>{
        const recording=request.result;
        if(!recording||recording.status!=='recording'){tx.abort();return;}
        const saved=markers(recording);
        if(detail.eventKey&&saved.some(m=>m.pendantEventKey===detail.eventKey)){done(false);return;}
        s.recordings.put({...recording,rememberMarkers:[...saved,marker]});done(true);
      };
    });
    if(!added)return null;
    root.dispatchEvent(new CustomEvent('synap-memory-highlight',{detail:{...marker,recordingId:current.recordingId}}));
    return marker;
  }
  function stamp(ms){const seconds=Math.floor(ms/1000);return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')}
  function attach(card,recording){
    const content=card.querySelector('.recording-content')||card;
    const saved=markers(recording);let panel=content.querySelector('.recording-moments');
    if(!saved.length){panel?.remove();return;}
    const text=content.querySelector('.recording-transcript');
    // An empty Transcript disclosure is a loading/retry surface. Keep saved
    // moments immediately playable while the recording has no transcript text.
    const transcript=text&&!text.hidden?text.closest('details'):null;
    if(!panel){panel=document.createElement('div');panel.className='recording-moments';content.append(panel)}
    const parent=transcript||content;
    if(panel.parentNode!==parent)parent.append(panel);
    const signature=saved.map(m=>m.id+':'+m.offsetMs).join(',');
    if(panel.dataset.markers===signature)return;panel.dataset.markers=signature;
    panel.replaceChildren();const label=document.createElement('strong');label.textContent='Marked moments';panel.append(label);
    for(const marker of saved){
      const button=document.createElement('button');button.type='button';button.textContent='★ '+stamp(marker.offsetMs);button.setAttribute('aria-label','Play marked moment at '+stamp(marker.offsetMs));
      button.addEventListener('click',async()=>{
        const audio=content.querySelector('audio');if(!audio)return;
        button.disabled=true;
        try{
          if(!audio.getAttribute('src')){const blob=recording.blob||await store.blob(recording);const url=URL.createObjectURL(blob);(content.synapAudioUrls||=[]).push(url);audio.src=url;}
          if(audio.readyState<1)await new Promise((resolve,reject)=>{
            const clean=()=>{clearTimeout(timer);audio.removeEventListener('loadedmetadata',ready);audio.removeEventListener('error',fail)};
            const ready=()=>{clean();resolve()},fail=()=>{clean();reject(Error('Audio could not load.'))};
            const timer=setTimeout(fail,15000);audio.addEventListener('loadedmetadata',ready,{once:true});audio.addEventListener('error',fail,{once:true});audio.load();
          });
          audio.currentTime=Math.min(marker.offsetMs/1000,Number.isFinite(audio.duration)?Math.max(0,audio.duration-.05):marker.offsetMs/1000);
          await audio.play();
        }catch(error){button.title=error.message;button.textContent='Tap Play · '+stamp(marker.offsetMs)}finally{button.disabled=false}
      });panel.append(button);
    }
  }
  root.SynapMoments={configure(options){store=options.store;context=options.context},mark,markers,attach};
})(globalThis);
