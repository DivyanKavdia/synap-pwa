/* Adopt hardware-started audio into the recorder's single journal.
   sleep-state-guard.js owns intentional sleep and reconnect preferences. */
(function(root){
  'use strict';
  let startingFromHardware=false,hardwareAdoptTimer=null;
  let intentionalSleep=Boolean(root.SynapSleepStateGuard?.locked);
  function clearHardwareAdoptTimer() {
    if (hardwareAdoptTimer) root.clearInterval(hardwareAdoptTimer);
    hardwareAdoptTimer = null;
  }


  /* A physical double-tap can put firmware into STREAMING before app.js has an
     open journal. Adopt that same stream by invoking Start once; firmware START
     is idempotent, so this opens browser storage without creating a second
     transport stream. */
  function adoptHardwareStream() {
    if (startingFromHardware || hardwareAdoptTimer || intentionalSleep) return;
    startingFromHardware = true;
    let attempts = 0;
    hardwareAdoptTimer = root.setInterval(() => {
      if (document.body.dataset.deviceState !== '2') {
        clearHardwareAdoptTimer();
        startingFromHardware = false;
        return;
      }
      const start = document.getElementById('startButton');
      if (start && !start.disabled) {
        clearHardwareAdoptTimer();
        start.click();
        startingFromHardware = false;
        return;
      }
      if (++attempts >= 40) {
        clearHardwareAdoptTimer();
        startingFromHardware = false;
      }
    }, 50);
  }


  function handleDeviceState(){
    if(document.body.dataset.deviceState==='2'&&document.body.dataset.state==='idle'&&!intentionalSleep){
      adoptHardwareStream();return;
    }
    clearHardwareAdoptTimer();startingFromHardware=false;
  }
  function bind(){
    root.addEventListener('synap-intentional-sleep',event=>{
      intentionalSleep=Boolean(event?.detail?.active);
      handleDeviceState();
    });
    new MutationObserver(handleDeviceState).observe(document.body,{
      attributes:true,attributeFilter:['data-device-state','data-state']
    });
    handleDeviceState();
  }
  root.SynapRecordingBridge=Object.freeze({get intentionalSleep(){return intentionalSleep}});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
})(globalThis);
