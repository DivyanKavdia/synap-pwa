/* Product-facing capture controls. Core BLE/recording behavior remains in app.js. */
(function(){
  'use strict';
  const TAGLINE='Stay present. Keep the memory.';
  const PUBLIC_VERSION='1.0.0';
  const logoSource=()=>window.SynapAppearance?.logoSource()||'synap-logo-'+(document.documentElement.dataset.theme==='dark'?'dark':'light')+'.png?v=1.0.0-ui-fix1';
  const ACTIVE_STATES=new Set(['idle','recording','starting','stopping','saving']);
  const RECORDING_STATES=new Set(['recording','starting']);
  const BUSY_STATES=new Set(['stopping','saving','updating','connecting']);

  function syncBrand(){
    const LOGO=logoSource();
    const headerLogo=document.querySelector('.topbar .brand-logo');
    if(headerLogo){headerLogo.src=LOGO;headerLogo.alt='synap';headerLogo.classList.add('synap-brand-image');}
  }

  function init(){
    syncBrand();
    const header=document.querySelector('.topbar');
    const actions=document.querySelector('.top-actions');
    const section=document.getElementById('capture');
    const connect=document.getElementById('connectButton');
    const start=document.getElementById('startButton');
    const stop=document.getElementById('stopButton');
    const timer=document.getElementById('timer');
    const settings=document.getElementById('settingsButton');
    settings?.addEventListener('click',()=>requestAnimationFrame(syncBrand));
    if(!header||!actions||!section||!connect||!start||!stop||!settings)return;

    document.title='synap · '+TAGLINE;
    document.querySelector('meta[name="description"]')?.setAttribute('content','synap — '+TAGLINE);
    const appVersion=document.getElementById('appVersion');
    if(appVersion)appVersion.textContent=PUBLIC_VERSION;

    /* Processing is automatic/product-managed. Low-level queue controls stay internal. */
    const processing=document.getElementById('processing');
    if(processing)processing.hidden=true;

    // Core control nodes remain mounted; the header owns their visible controls.
    section.hidden=true;
    const sessionBar=document.createElement('div');sessionBar.id='recordingSessionBar';sessionBar.hidden=true;
    const mark=document.createElement('button');mark.id='markMoment';mark.type='button';mark.textContent='★ Mark moment';
    const feedback=document.createElement('span');feedback.id='momentFeedback';feedback.setAttribute('role','status');
    if(timer){timer.setAttribute('aria-label','Recording elapsed time');sessionBar.append(timer)}
    sessionBar.append(feedback,mark);header.append(sessionBar);
    let marking=false;
    mark.addEventListener('click',async()=>{
      if(marking)return;marking=true;mark.disabled=true;
      try{await window.SynapMoments.mark();feedback.textContent='Moment saved'}
      catch(error){feedback.textContent=error.message||'Could not save moment. Try again.'}
      finally{marking=false;sync()}
    });

    let status=document.getElementById('headerPendantStatus');
    if(!status){
      status=document.createElement('button');
      status.id='headerPendantStatus';
      status.className='header-pendant-status';
      status.type='button';
      status.setAttribute('aria-label','Pendant connection');
      status.innerHTML='<span class="header-status-dot" aria-hidden="true"></span><span class="header-status-text">Offline</span>';
      status.addEventListener('click',()=>window.SynapAppControls?.toggleConnection());
    }

    let toggle=document.getElementById('headerCaptureToggle');
    if(!toggle){
      toggle=document.createElement('button');
      toggle.id='headerCaptureToggle';
      toggle.className='header-capture-toggle';
      toggle.type='button';
      toggle.setAttribute('aria-label','Start listening');
      toggle.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8"/></svg><span class="header-stop" aria-hidden="true"></span>';
      toggle.addEventListener('click',()=>window.SynapAppControls?.toggleCapture());
    }

    // Keep order deterministic across hot reloads and cached installs.
    if(status.parentNode!==actions)actions.prepend(status);
    if(toggle.parentNode!==actions)actions.insertBefore(toggle,settings);

    function sync(){
      const state=document.body.dataset.state||'disconnected';
      const ready=document.body.dataset.startup==='ready';
      const interrupted=document.body.dataset.recordingInterrupted==='true';
      const recording=RECORDING_STATES.has(state);
      const canStop=!stop.disabled;
      const connected=ACTIVE_STATES.has(state);
      const busy=BUSY_STATES.has(state);
      sessionBar.hidden=!['starting','recording','stopping','saving'].includes(state)&&document.body.dataset.recordingInterrupted!=='true';
      mark.hidden=state!=='recording';mark.disabled=marking||state!=='recording'||document.body.dataset.recordingInterrupted==='true';
      if(sessionBar.hidden)feedback.textContent='';
      status.classList.toggle('is-connected',connected);
      status.classList.toggle('is-recording',recording);
      const label=status.querySelector('.header-status-text');
      if(label)label.textContent=state==='updating'?'Updating':interrupted?'Paused':recording?'Listening':connected?'Connected':state==='connecting'?'Connecting':'Connect';
      status.disabled=connect.disabled;
      status.setAttribute('aria-label',connected?'Disconnect pendant':'Connect pendant');
      toggle.classList.toggle('is-connected',connected||state==='updating');
      toggle.classList.toggle('is-recording',recording||canStop);
      toggle.disabled=!ready||(!canStop&&(busy||state==='unsupported'||(connected&&start.disabled)));
      const action=canStop?(interrupted?'Save received recording':'Stop listening'):!connected?'Connect and start listening':'Start listening';
      toggle.setAttribute('aria-label',action);
      toggle.title=action;
    }

    if(document.documentElement.dataset.synapCaptureUiBound!=='1'){
      document.documentElement.dataset.synapCaptureUiBound='1';
      new MutationObserver(sync).observe(document.body,{attributes:true,attributeFilter:['data-state','data-startup','data-recording-interrupted']});
      new MutationObserver(sync).observe(connect,{attributes:true,attributeFilter:['disabled']});
      new MutationObserver(sync).observe(start,{attributes:true,attributeFilter:['disabled']});
      new MutationObserver(sync).observe(stop,{attributes:true,attributeFilter:['disabled']});
    }
    sync();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
