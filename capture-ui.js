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
    const settingsLogo=document.querySelector('.pendant-settings-top .settings-brand-logo');
    if(settingsLogo){
      settingsLogo.src=headerLogo?.getAttribute('src')||LOGO;
      settingsLogo.alt='synap';
      settingsLogo.classList.add('synap-brand-image');
      settingsLogo.dataset.brandSource='home-wordmark';
    }
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

    // The recorder is a primary product surface. Older compact revisions hid it
    // and left only the header shortcut, which made the app feel incomplete and
    // removed connection health / waveform / explicit Start-Stop affordances.
    section.classList.remove('capture-minimal');
    section.classList.add('capture-product');
    section.removeAttribute('aria-hidden');

    let status=document.getElementById('headerPendantStatus');
    if(!status){
      status=document.createElement('button');
      status.id='headerPendantStatus';
      status.className='header-pendant-status';
      status.type='button';
      status.setAttribute('aria-label','Pendant connection');
      status.innerHTML='<span class="header-status-dot" aria-hidden="true"></span><span class="header-status-text">Offline</span>';
      status.addEventListener('click',()=>connect.click());
    }

    let toggle=document.getElementById('headerCaptureToggle');
    if(!toggle){
      toggle=document.createElement('button');
      toggle.id='headerCaptureToggle';
      toggle.className='header-capture-toggle';
      toggle.type='button';
      toggle.setAttribute('aria-label','Start listening');
      toggle.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8"/></svg><span class="header-stop" aria-hidden="true"></span>';
      toggle.addEventListener('click',()=>{
        const state=document.body.dataset.state||'';
        (RECORDING_STATES.has(state)?stop:start).click();
      });
    }

    // Keep order deterministic across hot reloads and cached installs.
    if(status.parentNode!==actions)actions.prepend(status);
    if(toggle.parentNode!==actions)actions.insertBefore(toggle,settings);

    function sync(){
      const state=document.body.dataset.state||'disconnected';
      const recording=RECORDING_STATES.has(state);
      const connected=ACTIVE_STATES.has(state);
      const busy=BUSY_STATES.has(state);
      status.classList.toggle('is-connected',connected);
      status.classList.toggle('is-recording',recording);
      const label=status.querySelector('.header-status-text');
      if(label)label.textContent=recording?'Listening':connected?'Connected':state==='connecting'?'Connecting':'Offline';
      toggle.classList.toggle('is-recording',recording);
      toggle.disabled=busy&&!recording?true:(recording?stop.disabled:start.disabled);
      toggle.setAttribute('aria-label',recording?'Stop listening':'Start listening');
      if(timer)toggle.dataset.time=recording?timer.textContent:'';
    }

    if(document.documentElement.dataset.synapCaptureUiBound!=='1'){
      document.documentElement.dataset.synapCaptureUiBound='1';
      new MutationObserver(sync).observe(document.body,{attributes:true,attributeFilter:['data-state']});
      if(timer)new MutationObserver(()=>{if(RECORDING_STATES.has(document.body.dataset.state||''))toggle.dataset.time=timer.textContent||''}).observe(timer,{childList:true,subtree:true,characterData:true});
      new MutationObserver(sync).observe(start,{attributes:true,attributeFilter:['disabled']});
      new MutationObserver(sync).observe(stop,{attributes:true,attributeFilter:['disabled']});
    }
    sync();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
