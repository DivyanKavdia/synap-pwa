/* Optional controls for the live recording page. The service worker never owns audio. */
(function(root){
  'use strict';
  const KEY='synap-recording-notifications';
  let enabled=false,permissionBusy=false,worker=null,lastSignature='',lastError='';
  let pending=false,forcePending=false,flight=null,pageLeaving=false;
  const actionsInFlight=new Set();
  try{enabled=root.localStorage.getItem(KEY)==='on'}catch(_){}

  function capabilities(){
    const ios=/iPad|iPhone|iPod/.test(root.navigator?.userAgent||'') ||
      (root.navigator?.platform==='MacIntel' && root.navigator?.maxTouchPoints>1);
    const available=Boolean(root.isSecureContext && root.navigator?.serviceWorker &&
      root.Notification?.requestPermission && root.Notification.maxActions>0);
    return {available,ios,permission:root.Notification?.permission||'default'};
  }

  function currentState(){
    const desktop=root.SynapDesktopCapture?.state();
    if(desktop?.active)return {active:true,sessionId:'desktop:'+desktop.recordingId,
      source:'desktop',phase:'recording',startedAt:desktop.startedAt,canStop:true,canMark:false};
    return root.SynapAppControls?.recordingState()||{active:false};
  }

  function render(){
    const input=document.getElementById('recordingNotificationInput');
    const hint=document.getElementById('recordingNotificationHint');
    if(!input||!hint)return;
    const {available,ios,permission}=capabilities();
    input.checked=enabled && available && permission==='granted';
    input.disabled=permissionBusy || !available || permission==='denied';
    hint.textContent=lastError || (ios && !available
      ? 'Lock Screen recording controls and Dynamic Island require a native iOS app.'
      : !available ? 'Notification controls are unavailable here. Use Android Chrome or a supported desktop browser.'
      : permission==='denied' ? 'Notifications are blocked. Allow them in browser or device settings, then enable this switch.'
      : enabled && permission==='granted' ? 'Stop and mark moments from notifications. Keep Synap open; your phone may suspend recording in the background.'
      : 'Enable Stop & save and Mark moment while listening. Your browser will ask for notification permission.');
  }

  function request(target,data){
    return new Promise((resolve,reject)=>{
      const channel=new MessageChannel();
      const finish=(error,result)=>{
        clearTimeout(timer);channel.port1.close();
        error?reject(error):resolve(result);
      };
      const timer=setTimeout(()=>finish(Error('Notification controls did not respond. Reopen Synap to try again.')),5000);
      channel.port1.onmessage=event=>event.data?.ok ? finish(null,event.data) :
        finish(Error(event.data?.error||'Notification controls could not be shown.'));
      try{target.postMessage(data,[channel.port2])}catch(error){finish(error)}
    });
  }

  async function publish(force){
    if(!root.navigator?.serviceWorker?.getRegistration)return;
    const registration=await root.navigator.serviceWorker.getRegistration();
    if(!registration?.active)return;
    worker=registration.active;
    const {available,permission}=capabilities();
    const state=!pageLeaving && enabled && available && permission==='granted' ? currentState() : {active:false};
    // Wall-clock conversion can vary by a millisecond; state transitions alone
    // update the notification. Its timestamp supplies the OS's elapsed display.
    const signature=JSON.stringify([state.active,state.sessionId,state.phase,state.canStop,state.canMark]);
    if(!force && signature===lastSignature)return;
    await request(worker,{type:'SYNAP_RECORDING_NOTIFICATION',state});
    lastSignature=signature;lastError='';render();
  }

  function sync(force=false){
    pending=true;forcePending=forcePending||force;
    if(!flight)flight=(async()=>{
      // Coalesce mutations before reading the recorder's authoritative state.
      await Promise.resolve();
      while(pending){
        pending=false;const refresh=forcePending;forcePending=false;
        try{await publish(refresh)}catch(error){
          lastSignature='';
          if(enabled){lastError=error.message||'Recording notifications are unavailable.';render()}
        }
      }
    })().finally(()=>{flight=null});
    return flight;
  }

  async function changePreference(event){
    const wanted=event.target.checked;
    lastError='';permissionBusy=true;render();
    try{
      // Invoke permission synchronously in this switch's user gesture.
      const permission=wanted && root.Notification.permission!=='granted'
        ? await root.Notification.requestPermission() : root.Notification.permission;
      enabled=wanted && permission==='granted';
      root.localStorage.setItem(KEY,enabled?'on':'off');
    }catch(error){enabled=false;lastError=error.message||'Could not enable notifications.'}
    finally{permissionBusy=false;render();sync(true)}
  }

  async function handleAction(event){
    const data=event.data;
    if(data?.type!=='SYNAP_RECORDING_ACTION')return;
    if(!event.source || (event.source!==worker && event.source!==root.navigator.serviceWorker.controller))return;
    if(event.origin && event.origin!==root.location.origin)return;
    const reply=ok=>event.ports?.[0]?.postMessage({ok});
    const current=currentState();
    if(!enabled || capabilities().permission!=='granted' || !current.active ||
      current.sessionId!==data.sessionId || !Number.isFinite(data.expiresAt) ||
      Date.now()>data.expiresAt || actionsInFlight.has(data.sessionId)) {reply(false);return}
    const valid=data.action==='stop' ? current.canStop : data.action==='mark' && current.canMark;
    if(!valid){reply(false);return}
    actionsInFlight.add(data.sessionId);
    try{
      let result;
      if(data.action==='mark')result=await root.SynapMoments.mark();
      else if(current.source==='desktop')result=await root.SynapDesktopCapture.stop('notification-stop');
      else result=await root.SynapAppControls.stopCapture(data.sessionId);
      reply(Boolean(result));
    }catch(error){
      lastError=error.message||'Open Synap to finish this action.';render();reply(false);
    }finally{actionsInFlight.delete(data.sessionId);sync(true)}
  }

  function init(){
    document.getElementById('recordingNotificationInput')?.addEventListener('change',changePreference);
    if(root.navigator?.serviceWorker){
      root.navigator.serviceWorker.addEventListener('message',handleAction);
      root.navigator.serviceWorker.addEventListener('controllerchange',()=>{lastSignature='';sync(true)});
      root.navigator.serviceWorker.ready?.then(()=>sync(true)).catch(()=>{});
    }
    new MutationObserver(()=>sync()).observe(document.body,{attributes:true,
      attributeFilter:['data-state','data-recording-interrupted','data-startup']});
    for(const name of ['synap-desktop-capture-started','synap-desktop-capture-stopped','synap-recording-saved'])
      root.addEventListener(name,()=>sync());
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='visible'){render();sync(true)}
    });
    root.addEventListener('pagehide',()=>{pageLeaving=true;sync(true)});
    root.addEventListener('pageshow',()=>{pageLeaving=false;render();sync(true)});
    root.addEventListener('storage',event=>{
      if(event.key!==KEY)return;enabled=event.newValue==='on';render();sync(true);
    });
    root.navigator?.permissions?.query({name:'notifications'}).then(permission=>{
      permission.addEventListener('change',()=>{render();sync(true)});
    }).catch(()=>{});
    render();sync(true);
  }
  root.SynapRecordingNotifications=Object.freeze({capabilities,sync});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
