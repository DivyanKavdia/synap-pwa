/* Optional, session-local listening copies. Recording storage remains authoritative. */
(function(root){
  'use strict';
  const views=new Set(),busyStates=new Set(['recording','starting','stopping','saving','updating']);
  let observer;
  function captureBusy(){return busyStates.has(document.body.dataset.state)}
  function refresh(){for(const view of views)view.refresh()}
  root.addEventListener('synap-audio-enhancement-state',refresh);
  function attach(container,audio,getOriginal,name){
    const api=root.SynapAudioEnhancement;if(!api?.supported())return;
    const box=document.createElement('section');box.className='speech-enhancement';
    box.innerHTML='<h4>Audio preview</h4><p>New cloud uploads get gentle noise reduction automatically. Preview the same treatment here; the original stays available.</p><div class="speech-controls"><button type="button" data-speech="enhance">Preview clearer audio</button><button type="button" data-speech="cancel" hidden>Cancel</button><button type="button" data-speech="original" aria-pressed="true" hidden>Original</button><button type="button" data-speech="enhanced" aria-pressed="false" hidden>Enhanced</button><button type="button" data-speech="export" hidden>Export enhanced copy</button></div><progress max="1" value="0" aria-label="Speech enhancement progress" hidden></progress><p class="speech-status" role="status" hidden></p>';
    container.appendChild(box);
    const button=key=>box.querySelector('[data-speech="'+key+'"]'),status=box.querySelector('.speech-status'),progress=box.querySelector('progress');
    let controller=null,enhancedURL='',originalURL='',disposed=false;
    const say=text=>{status.textContent=text;status.hidden=!text};
    const view={
      refresh(){
        if(captureBusy()&&controller)controller.abort();
        button('enhance').disabled=captureBusy()||api.busy()||!!controller;
      },
      dispose(){disposed=true;controller?.abort();audio.pause();for(const url of[enhancedURL,originalURL])if(url)URL.revokeObjectURL(url);views.delete(view);if(!views.size){observer?.disconnect();observer=null}}
    };
    box.__speechView=view;views.add(view);
    if(!observer){observer=new MutationObserver(refresh);observer.observe(document.body,{attributes:true,attributeFilter:['data-state']})}
    function select(which){
      const time=audio.currentTime||0;audio.pause();audio.src=which==='enhanced'?enhancedURL:originalURL;
      audio.addEventListener('loadedmetadata',()=>{audio.currentTime=Math.min(time,Number.isFinite(audio.duration)?audio.duration:time)},{once:true});audio.load();
      for(const key of['original','enhanced'])button(key).setAttribute('aria-pressed',String(key===which));
    }
    button('enhance').addEventListener('click',async()=>{
      if(captureBusy()||controller||api.busy())return;
      controller=new AbortController();const signal=controller.signal;
      button('cancel').hidden=false;progress.hidden=false;progress.value=0;say('Preparing your recording…');refresh();
      try{
        const original=await getOriginal();if(signal.aborted)throw new DOMException('Cancelled','AbortError');
        if(!original)throw new Error('Source audio is not stored on this device.');
        if(!originalURL)originalURL=URL.createObjectURL(original);
        const result=await api.enhance(original,{signal,onProgress:value=>{progress.value=value.progress;say(value.stage==='loading'?'Loading the local speech model…':value.stage==='complete'?'Copy ready.':'Reducing noise · '+Math.round(value.progress*100)+'%')}});
        if(disposed||signal.aborted)return;
        if(enhancedURL)URL.revokeObjectURL(enhancedURL);enhancedURL=URL.createObjectURL(result);
        for(const key of['original','enhanced','export'])button(key).hidden=false;
        select('enhanced');say('Noise-reduced copy ready. Original audio and memory are unchanged.');
      }catch(error){if(!disposed)say(error.name==='AbortError'?(captureBusy()?'Enhancement stopped while capture is active.':'Enhancement cancelled.'):error.message||'Enhancement could not finish.');}
      finally{controller=null;button('cancel').hidden=true;progress.hidden=true;refresh()}
    });
    button('cancel').addEventListener('click',()=>controller?.abort());
    button('original').addEventListener('click',()=>select('original'));
    button('enhanced').addEventListener('click',()=>select('enhanced'));
    button('export').addEventListener('click',()=>{const anchor=document.createElement('a');anchor.href=enhancedURL;anchor.download=String(name()||'Recording').replace(/[\\/:*?"<>|]/g,'-')+'-enhanced.wav';document.body.appendChild(anchor);anchor.click();anchor.remove()});
    view.refresh();
  }
  root.SynapSpeechUI={attach,dispose:container=>container.querySelectorAll('.speech-enhancement').forEach(box=>box.__speechView?.dispose())};
})(window);
