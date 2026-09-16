/* Adopt physical START through the recorder, without issuing another START.
   sleep-state-guard.js owns intentional sleep and reconnect preferences. */
(function(root){
  'use strict';
  let intentionalSleep=Boolean(root.SynapSleepStateGuard?.locked);
  function handleStatus(){
    if(document.body?.dataset.deviceState==='2' && document.body.dataset.state==='idle' && !intentionalSleep)
      root.SynapAppControls?.adoptHardwareStream?.();
  }
  function bind(){
    root.addEventListener('synap-intentional-sleep',event=>{
      intentionalSleep=Boolean(event?.detail?.active);
      handleStatus();
    });
    // Readiness may finish after a status arrives. Session guards prevent
    // duplicate adoption; normal notifications call handleStatus synchronously.
    new MutationObserver(handleStatus).observe(document.body,{
      attributes:true,attributeFilter:['data-device-state','data-state','data-startup']
    });
    handleStatus();
  }
  root.SynapRecordingBridge=Object.freeze({handleStatus,get intentionalSleep(){return intentionalSleep}});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
})(globalThis);
