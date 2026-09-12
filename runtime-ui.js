/* Runtime UX contracts that must stay stable across dynamically injected synap modules. */
(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const blobUrls=new Map();

  function installBlobRegistry(){
    if(typeof URL==='undefined'||typeof URL.createObjectURL!=='function'||URL.createObjectURL.__synapWrapped)return;
    const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL?.bind(URL);
    const wrapped=function(value){
      const url=create(value);
      if(typeof Blob!=='undefined'&&value instanceof Blob)blobUrls.set(url,value);
      return url;
    };
    wrapped.__synapWrapped=true;
    URL.createObjectURL=wrapped;
    if(revoke){
      URL.revokeObjectURL=function(url){blobUrls.delete(String(url||''));return revoke(url)};
    }
  }

  function bindTouchRecordingBridge(){
    const body=document.body,start=$('startButton');
    if(!body||!start||typeof MutationObserver==='undefined')return;
    let lastDeviceState=body.dataset.deviceState||'';
    function sync(){
      const deviceState=body.dataset.deviceState||'';
      const appState=body.dataset.state||'';
      const physicalStart=deviceState==='2'&&lastDeviceState!=='2';
      lastDeviceState=deviceState;
      if(physicalStart&&appState==='idle'&&!start.disabled){
        start.dataset.trigger='touch';
        start.click();
        queueMicrotask(()=>{if(start.dataset.trigger==='touch')delete start.dataset.trigger;});
      }
    }
    new MutationObserver(sync).observe(body,{attributes:true,attributeFilter:['data-device-state','data-state']});
  }

  function bindRecordingControls(){
    const list=$('recordingsList');
    if(!list)return;
    const loaders=new WeakMap(),wired=new WeakSet(),pollers=new WeakMap();
    const label=button=>(button?.textContent||'').replace(/\s+/g,' ').trim();
    const source=audio=>String(audio?.currentSrc||audio?.getAttribute?.('src')||audio?.src||'');
    const blobFor=audio=>blobUrls.get(source(audio))||blobUrls.get(String(audio?.src||''))||null;
    const filename=card=>{
      const raw=(card?.querySelector('.recording-row-name')?.textContent||'synap recording').trim();
      return (raw||'synap recording').replace(/[\\/:*?"<>|]+/g,'-').replace(/\s+/g,' ').trim()+'.wav';
    };
    function notify(message,type){
      const region=$('toastRegion');
      if(!region)return;
      const el=document.createElement('div');
      el.className='toast'+(type==='error'?' toast-error':'');
      el.textContent=message;region.appendChild(el);setTimeout(()=>el.remove(),3200);
    }
    function markReady(card,audio,exportButton){
      const ready=!!blobFor(audio);
      audio.classList.toggle('synap-audio-loading',!ready);
      audio.setAttribute('aria-busy',String(!ready));
      if(exportButton){
        exportButton.disabled=!ready;
        exportButton.title=ready?'Export WAV':'Preparing audio…';
        exportButton.setAttribute('aria-label',ready?'Export recording as WAV':'Preparing recording for export');
      }
      if(ready){
        const timer=pollers.get(card);if(timer){clearInterval(timer);pollers.delete(card)}
      }
      return ready;
    }
    function wire(card){
      if(!card)return;
      const content=card.querySelector('.recording-content');
      if(!content)return;
      const audio=content.querySelector('audio'),actions=content.querySelector('.recording-actions');
      if(!audio||!actions)return;
      const buttons=[...actions.querySelectorAll('button')];
      const load=buttons.find(button=>/^(load audio|play)$/i.test(label(button)));
      const exportButton=buttons.find(button=>/^(download|export)$/i.test(label(button)));
      if(load&&!loaders.has(card)){
        loaders.set(card,load);
        load.hidden=true;load.tabIndex=-1;load.setAttribute('aria-hidden','true');
      }
      if(exportButton){exportButton.textContent='Export';exportButton.dataset.synapExport='1'}
      if(!wired.has(content)){
        wired.add(content);
        audio.addEventListener('loadstart',()=>markReady(card,audio,exportButton));
        audio.addEventListener('loadedmetadata',()=>markReady(card,audio,exportButton));
        audio.addEventListener('canplay',()=>markReady(card,audio,exportButton));
        audio.addEventListener('error',()=>{if(exportButton){exportButton.disabled=true;exportButton.title='Audio could not be prepared'}});
      }
      if(markReady(card,audio,exportButton))return;
      const loader=loaders.get(card);
      if(loader&&!card.dataset.synapAudioPreparing){
        card.dataset.synapAudioPreparing='1';
        loader.click();
        let attempts=0;
        const timer=setInterval(()=>{
          attempts+=1;
          if(markReady(card,audio,exportButton)||attempts>=80){
            clearInterval(timer);pollers.delete(card);delete card.dataset.synapAudioPreparing;
            if(attempts>=80&&!blobFor(audio))notify('Audio could not be prepared. Close and reopen this recording.','error');
          }
        },125);
        pollers.set(card,timer);
      }
    }
    function scan(root=list){
      if(root.matches?.('.recording-card'))wire(root);
      root.querySelectorAll?.('.recording-card').forEach(wire);
    }
    list.addEventListener('click',event=>{
      const button=event.target.closest?.('button[data-synap-export="1"]');
      if(!button)return;
      event.preventDefault();event.stopImmediatePropagation();
      const card=button.closest('.recording-card'),audio=card?.querySelector('audio'),blob=blobFor(audio);
      if(!blob){notify('Audio is still preparing. Try Export again in a moment.','error');return}
      const name=filename(card),url=source(audio);
      let shared=false;
      try{
        if(typeof File!=='undefined'&&navigator.share){
          const file=new File([blob],name,{type:blob.type||'audio/wav'});
          if(!navigator.canShare||navigator.canShare({files:[file]})){
            shared=true;
            const promise=navigator.share({files:[file],title:name.replace(/\.wav$/i,'')});
            Promise.resolve(promise).catch(error=>{if(error?.name!=='AbortError')notify('Could not open the share sheet.','error')});
          }
        }
      }catch(_){shared=false}
      if(shared)return;
      const ios=/iPad|iPhone|iPod/i.test(navigator.userAgent||'')||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
      if(ios){
        const opened=window.open(url,'_blank','noopener');
        if(!opened)notify('Your browser blocked the export. Allow pop-ups for synap and try again.','error');
        return;
      }
      const anchor=document.createElement('a');
      anchor.href=url;anchor.download=name;anchor.rel='noopener';
      document.body.appendChild(anchor);anchor.click();anchor.remove();
    },true);
    list.addEventListener('toggle',event=>{const card=event.target.closest?.('.recording-card');if(card?.open)requestAnimationFrame(()=>wire(card))},true);
    new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes||[])if(node.nodeType===1)scan(node)}).observe(list,{childList:true,subtree:true});
    scan();
  }

  function bindTapResponsiveness(){
    if($('synapTapResponsiveness'))return;
    const style=document.createElement('style');style.id='synapTapResponsiveness';
    style.textContent='button,summary,a,[role="button"]{touch-action:manipulation;-webkit-tap-highlight-color:transparent}.recording-actions button,.firmware-actions button,.pendant-actions button,.recorder-controls button,.appearance-options button,.brain-tabs a{min-height:44px}.recording-actions button:disabled{opacity:.48}.recording-card audio.synap-audio-loading{opacity:.5;pointer-events:none}.recording-card audio{min-height:44px}@media(max-width:640px){.recording-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.recording-actions>button,.recording-actions>.recording-more{min-width:0;width:100%}.recording-actions button{width:100%}}';
    document.head.appendChild(style);
  }

  function bindBrainTabs(){
    const nav=document.querySelector('.brain-tabs');
    if(!nav)return;
    let raf=0,lockedHref='',lockTimer=0;
    const links=()=>[...nav.querySelectorAll('a[href^="#"]')];
    const findLink=href=>links().find(link=>link.getAttribute('href')===href)||null;
    function select(link){
      for(const item of links()){
        const active=item===link;
        item.classList.toggle('active',active);
        if(active)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');
      }
    }
    function releaseLock(){
      lockedHref='';
      lockTimer=0;
      schedule();
    }
    function lock(link,duration=1400){
      lockedHref=link?.getAttribute('href')||'';
      if(lockTimer)clearTimeout(lockTimer);
      lockTimer=lockedHref?setTimeout(releaseLock,duration):0;
    }
    function update(){
      raf=0;
      const items=links().map(link=>({link,section:document.querySelector(link.getAttribute('href'))})).filter(x=>x.section);
      if(!items.length)return;
      if(lockedHref){
        const locked=items.find(item=>item.link.getAttribute('href')===lockedHref);
        if(locked){select(locked.link);return;}
        lockedHref='';
      }
      const header=document.querySelector('.topbar');
      const boundary=(header?.getBoundingClientRect().bottom||70)+28;
      const navHeight=nav.getBoundingClientRect?.().height||0;
      const viewportBottom=Math.max(boundary+1,window.innerHeight-navHeight-8);
      let chosen=items[0],bestVisible=-1;
      for(const item of items){
        const rect=item.section.getBoundingClientRect();
        const visible=Math.max(0,Math.min(rect.bottom,viewportBottom)-Math.max(rect.top,boundary));
        if(visible>bestVisible){bestVisible=visible;chosen=item}
      }
      if(bestVisible<=0){
        chosen=items[0];
        for(const item of items)if(item.section.getBoundingClientRect().top<=boundary)chosen=item;
      }
      const bottomGap=document.documentElement.scrollHeight-(window.scrollY+window.innerHeight);
      const bottomTolerance=Math.max(96,Math.round(window.innerHeight*.08));
      if(window.scrollY>0&&bottomGap<=bottomTolerance)chosen=items[items.length-1];
      select(chosen.link);
    }
    function schedule(){if(!raf)raf=requestAnimationFrame(update)}
    function navigate(link){
      const href=link.getAttribute('href');
      const section=href?document.querySelector(href):null;
      lock(link);
      select(link);
      if(section){
        const reduced=typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        section.scrollIntoView({behavior:reduced?'auto':'smooth',block:'start'});
      }
      try{
        if(typeof history!=='undefined'&&typeof history.replaceState==='function')history.replaceState(history.state,'',location.pathname+location.search);
      }catch(_){}
    }
    nav.addEventListener('click',event=>{
      const link=event.target.closest('a[href^="#"]');
      if(!link)return;
      event.preventDefault();
      navigate(link);
    });
    addEventListener('scroll',schedule,{passive:true});
    addEventListener('resize',schedule,{passive:true});
    addEventListener('hashchange',()=>{
      const link=typeof location!=='undefined'?findLink(location.hash):null;
      if(link){lock(link,1000);select(link)}
      schedule();
    });
    new MutationObserver(schedule).observe(nav,{childList:true,subtree:true});
    if(typeof ResizeObserver!=='undefined'){
      const observer=new ResizeObserver(schedule);observer.observe(document.querySelector('main')||document.body);
    }
    update();
  }

  function bindReducedMotion(){
    const media=typeof window.matchMedia==='function'?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
    const apply=()=>document.documentElement.toggleAttribute('data-reduced-motion',!!media?.matches);
    media?.addEventListener?.('change',apply);apply();
  }

  installBlobRegistry();
  function init(){if(!globalThis.SynapRecordingBridge)bindTouchRecordingBridge();bindRecordingControls();bindTapResponsiveness();if(!globalThis.SynapDashboardUI)bindBrainTabs();bindReducedMotion()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
