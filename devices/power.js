/* Standby requires firmware that reports CONNECTED_IDLE while asleep. */
(function(root){'use strict';
const CONTROL_UUID='4fa12347-0000-1000-8000-00805f9b34fb';
const PROTOCOL_VERSION=0x02,CMD_STANDBY=0x03,CMD_WAKE=0x04,CMD_RESTART=0x05;
const POWER_MAGIC=0xE2,POWER_VERSION=1,POWER_AWAKE=1,POWER_STANDBY=2,POWER_DEEP_SLEEP=3,POWER_WAKE_RECORD=4;
const IDLE_TO_STANDBY_MS=30000,MIN_SAFE_STANDBY_BUILD=1125,MIN_RESTART_BUILD=1508;
let connection=null,control=null,standbyTimer=0,autoStartPending=false,lastPowerState=0,firmwareBuild=0,writeBusy=false,stateObserver=null,restartAwaitingReconnect=false;
function state(){return String(document.body?.dataset?.state||'')}
function cancelStandby(){if(standbyTimer){clearTimeout(standbyTimer);standbyTimer=0}}
function compatibleStandby(){
  const info=root.SynapModules?.client?.module;
  return firmwareBuild>=MIN_SAFE_STANDBY_BUILD && (!info || root.SynapCapabilities.supports(info,'standby'));
}
function eligibleIdle(){return compatibleStandby()&&state()==='idle'&&document.body?.dataset?.deviceState==='1'}
function renderRestartControl(){
  const button=document.getElementById('firmwareRestart');
  if(!button)return;
  const supported=Boolean(connection)&&firmwareBuild>=MIN_RESTART_BUILD;
  button.hidden=!supported;
  button.disabled=!supported||state()!=='idle'||writeBusy;
  button.title=!supported?'Available after firmware build '+MIN_RESTART_BUILD:
    state()!=='idle'?'Finish the current device activity before restarting.':'Restart the pendant firmware';
}
async function getControl(current){if(control)return control;const next=await current.queue(()=>current.service.getCharacteristic(CONTROL_UUID),'Find standby control');if(connection!==current)return null;control=next;return control}
async function writeControl(c,payload){
  if(c.properties?.write&&typeof c.writeValueWithResponse==='function')await c.writeValueWithResponse(payload);
  else if(c.properties?.writeWithoutResponse&&typeof c.writeValueWithoutResponse==='function')await c.writeValueWithoutResponse(payload);
  else await c.writeValue(payload);
}
async function writeStandby(){
  standbyTimer=0;if(writeBusy||!connection||!eligibleIdle()||lastPowerState===POWER_STANDBY)return;
  writeBusy=true;const current=connection;
  try{
    const c=await getControl(current);if(!c)return;
    const sent=await current.queue(async()=>{
      if(connection!==current||!eligibleIdle()||lastPowerState===POWER_STANDBY)return false;
      await writeControl(c,new Uint8Array([CMD_STANDBY,PROTOCOL_VERSION]));
      return true;
    },'Enter pendant standby');
    if(sent&&connection===current&&eligibleIdle())document.body.dataset.powerState='standby';
  }catch(error){
    console.warn('[synap power] standby command failed',error);
    if(connection===current&&eligibleIdle())standbyTimer=setTimeout(writeStandby,10000);
  }finally{writeBusy=false}
}
async function restartFirmware(){
  cancelStandby();
  if(!connection)throw Error('Pendant is not connected.');
  if(firmwareBuild<MIN_RESTART_BUILD)throw Error('Update pendant firmware before restarting from the app.');
  if(state()!=='idle')throw Error('Finish the current device activity before restarting.');
  if(writeBusy)throw Error('Another device command is still finishing.');
  writeBusy=true;renderRestartControl();
  const current=connection;
  try{
    const c=await getControl(current);
    if(!c||connection!==current)throw Error('Pendant control is unavailable.');
    restartAwaitingReconnect=true;
    await current.queue(async()=>{
      if(connection!==current)throw Error('Pendant disconnected before restart.');
      await writeControl(c,new Uint8Array([CMD_RESTART,PROTOCOL_VERSION]));
    },'Restart pendant firmware');
    return true;
  }catch(error){
    restartAwaitingReconnect=false;
    throw error;
  }finally{writeBusy=false;renderRestartControl()}
}
async function wakeForActivity(){
  cancelStandby();
  if(!connection)throw Error('Pendant is not connected.');
  const current=connection,c=await getControl(current);
  if(!c||connection!==current)throw Error('Pendant control is unavailable.');
  await current.queue(async()=>{
    if(connection!==current)throw Error('Pendant disconnected before wake.');
    await writeControl(c,new Uint8Array([CMD_WAKE,PROTOCOL_VERSION]));
  },'Wake pendant for device activity');
  // Firmware publishes POWER_AWAKE when leaving remote standby. Wait for that
  // state so the following media command cannot overtake the control task.
  const deadline=Date.now()+1200;
  while(connection===current &&
    (lastPowerState===POWER_STANDBY||document.body?.dataset?.powerState==='standby') &&
    Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
  if(connection!==current)throw Error('Pendant disconnected while waking.');
  if(lastPowerState===POWER_STANDBY||document.body?.dataset?.powerState==='standby')
    throw Error('Pendant did not leave standby.');
  if(document.body)document.body.dataset.powerState='awake';
  scheduleStandby();
  return true;
}
function scheduleStandby(){cancelStandby();if(!connection||!compatibleStandby()||state()!=='idle'||lastPowerState===POWER_STANDBY)return;standbyTimer=setTimeout(writeStandby,IDLE_TO_STANDBY_MS)}
function tryAutoStart(){if(root.SynapRecordingBridge)return;if(!autoStartPending)return;const button=document.getElementById('startButton');if(state()!=='idle'||!button||button.disabled)return;autoStartPending=false;document.body.dataset.powerIntent='';setTimeout(()=>{if(state()==='idle'&&!button.disabled)button.click()},80)}
function onStateChange(){const s=state();if(s==='idle'){tryAutoStart();scheduleStandby()}else cancelStandby();renderRestartControl()}
function bindStateObserver(){if(stateObserver||!root.MutationObserver||!document.body)return;stateObserver=new MutationObserver(onStateChange);stateObserver.observe(document.body,{attributes:true,attributeFilter:['data-state','data-device-state']});onStateChange()}
function parseHex(hex){return String(hex||'').trim().split(/\s+/).filter(Boolean).map(x=>Number.parseInt(x,16))}
function onPowerPacket(event){
  const bytes=parseHex(event?.detail?.hex);if(bytes.length!==6||bytes[0]!==POWER_MAGIC||bytes[1]!==POWER_VERSION)return;
  lastPowerState=bytes[2];firmwareBuild=(bytes[4]||0)|((bytes[5]||0)<<8);if(document.body)document.body.dataset.firmwareBuild=String(firmwareBuild);
  document.body.dataset.powerState=lastPowerState===POWER_STANDBY?'standby':lastPowerState===POWER_DEEP_SLEEP?'deep-sleep':'awake';
  if(lastPowerState===POWER_WAKE_RECORD&&compatibleStandby()){autoStartPending=true;document.body.dataset.powerIntent='record';tryAutoStart()}
  if((lastPowerState===POWER_AWAKE||lastPowerState===POWER_WAKE_RECORD)&&compatibleStandby())scheduleStandby();
  renderRestartControl();
}
root.addEventListener('synap-module-changed',onStateChange);
root.addEventListener('synap-event-packet',onPowerPacket);
root.addEventListener('synap-gatt-service-ready',event=>{connection=event.detail;control=null;lastPowerState=0;firmwareBuild=0;bindStateObserver();cancelStandby();renderRestartControl();setTimeout(tryAutoStart,900)});
root.addEventListener('synap-gatt-ready',()=>{
  if(!restartAwaitingReconnect)return;
  restartAwaitingReconnect=false;
  setTimeout(async()=>{
    await root.SynapModules?.refresh?.().catch(()=>{});
    root.dispatchEvent?.(new CustomEvent('synap-firmware-restart-reconnected',{
      detail:{module:root.SynapModules?.client?.module||null}
    }));
  },250);
});
root.addEventListener('synap-gatt-disconnected',()=>{connection=null;control=null;firmwareBuild=0;lastPowerState=0;autoStartPending=false;cancelStandby();renderRestartControl()});
function bindRestartControl(){
  const button=document.getElementById('firmwareRestart');
  if(!button||button.dataset.bound==='true')return;
  button.dataset.bound='true';
  button.addEventListener('click',async()=>{
    if(!confirm('Restart the connected pendant firmware now? Recording must be stopped.'))return;
    const status=document.getElementById('otaStatus');
    button.disabled=true;
    if(status)status.textContent='Restarting pendant…';
    try{await restartFirmware()}
    catch(error){if(status)status.textContent='Restart failed · '+error.message}
    finally{renderRestartControl()}
  });
  renderRestartControl();
}
if(document.body){bindStateObserver();bindRestartControl()}else document.addEventListener('DOMContentLoaded',()=>{bindStateObserver();bindRestartControl()},{once:true});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){bindStateObserver();tryAutoStart();scheduleStandby();renderRestartControl()}});
root.SynapPowerLifecycle={IDLE_TO_STANDBY_MS,MIN_SAFE_STANDBY_BUILD,MIN_RESTART_BUILD,get state(){return lastPowerState},get firmwareBuild(){return firmwareBuild},get autoStartPending(){return autoStartPending},schedule:scheduleStandby,wakeForActivity,restartFirmware};
})(globalThis);
