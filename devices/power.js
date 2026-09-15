/* Standby requires firmware that reports CONNECTED_IDLE while asleep. */
(function(root){'use strict';
const CONTROL_UUID='4fa12347-0000-1000-8000-00805f9b34fb';
const PROTOCOL_VERSION=0x02,CMD_STANDBY=0x03;
const POWER_MAGIC=0xE2,POWER_VERSION=1,POWER_AWAKE=1,POWER_STANDBY=2,POWER_DEEP_SLEEP=3,POWER_WAKE_RECORD=4;
const IDLE_TO_STANDBY_MS=30000,MIN_SAFE_STANDBY_BUILD=1125;
let connection=null,control=null,standbyTimer=0,autoStartPending=false,lastPowerState=0,firmwareBuild=0,writeBusy=false,stateObserver=null;
function state(){return String(document.body?.dataset?.state||'')}
function cancelStandby(){if(standbyTimer){clearTimeout(standbyTimer);standbyTimer=0}}
function compatibleStandby(){
  const info=root.SynapModules?.client?.module;
  return firmwareBuild>=MIN_SAFE_STANDBY_BUILD && (!info || root.SynapCapabilities.supports(info,'standby'));
}
function eligibleIdle(){return compatibleStandby()&&state()==='idle'&&document.body?.dataset?.deviceState==='1'}
async function getControl(current){if(control)return control;const next=await current.queue(()=>current.service.getCharacteristic(CONTROL_UUID),'Find standby control');if(connection!==current)return null;control=next;return control}
async function writeStandby(){
  standbyTimer=0;if(writeBusy||!connection||!eligibleIdle()||lastPowerState===POWER_STANDBY)return;
  writeBusy=true;const current=connection;
  try{
    const c=await getControl(current);if(!c)return;
    const sent=await current.queue(async()=>{
      if(connection!==current||!eligibleIdle()||lastPowerState===POWER_STANDBY)return false;
      const payload=new Uint8Array([CMD_STANDBY,PROTOCOL_VERSION]);
      if(c.properties?.write&&typeof c.writeValueWithResponse==='function')await c.writeValueWithResponse(payload);
      else if(c.properties?.writeWithoutResponse&&typeof c.writeValueWithoutResponse==='function')await c.writeValueWithoutResponse(payload);
      else await c.writeValue(payload);
      return true;
    },'Enter pendant standby');
    if(sent&&connection===current&&eligibleIdle())document.body.dataset.powerState='standby';
  }catch(error){
    console.warn('[synap power] standby command failed',error);
    if(connection===current&&eligibleIdle())standbyTimer=setTimeout(writeStandby,10000);
  }finally{writeBusy=false}
}
function scheduleStandby(){cancelStandby();if(!connection||!compatibleStandby()||state()!=='idle'||lastPowerState===POWER_STANDBY)return;standbyTimer=setTimeout(writeStandby,IDLE_TO_STANDBY_MS)}
function tryAutoStart(){if(root.SynapRecordingBridge)return;if(!autoStartPending)return;const button=document.getElementById('startButton');if(state()!=='idle'||!button||button.disabled)return;autoStartPending=false;document.body.dataset.powerIntent='';setTimeout(()=>{if(state()==='idle'&&!button.disabled)button.click()},80)}
function onStateChange(){const s=state();if(s==='idle'){tryAutoStart();scheduleStandby()}else cancelStandby()}
function bindStateObserver(){if(stateObserver||!root.MutationObserver||!document.body)return;stateObserver=new MutationObserver(onStateChange);stateObserver.observe(document.body,{attributes:true,attributeFilter:['data-state','data-device-state']});onStateChange()}
function parseHex(hex){return String(hex||'').trim().split(/\s+/).filter(Boolean).map(x=>Number.parseInt(x,16))}
function onPowerPacket(event){
  const bytes=parseHex(event?.detail?.hex);if(bytes.length!==6||bytes[0]!==POWER_MAGIC||bytes[1]!==POWER_VERSION)return;
  lastPowerState=bytes[2];firmwareBuild=(bytes[4]||0)|((bytes[5]||0)<<8);if(document.body)document.body.dataset.firmwareBuild=String(firmwareBuild);
  document.body.dataset.powerState=lastPowerState===POWER_STANDBY?'standby':lastPowerState===POWER_DEEP_SLEEP?'deep-sleep':'awake';
  if(lastPowerState===POWER_WAKE_RECORD&&compatibleStandby()){autoStartPending=true;document.body.dataset.powerIntent='record';tryAutoStart()}
  if((lastPowerState===POWER_AWAKE||lastPowerState===POWER_WAKE_RECORD)&&compatibleStandby())scheduleStandby();
}
root.addEventListener('synap-module-changed',onStateChange);
root.addEventListener('synap-event-packet',onPowerPacket);
root.addEventListener('synap-gatt-service-ready',event=>{connection=event.detail;control=null;lastPowerState=0;firmwareBuild=0;bindStateObserver();cancelStandby();setTimeout(tryAutoStart,900)});
root.addEventListener('synap-gatt-disconnected',()=>{connection=null;control=null;firmwareBuild=0;lastPowerState=0;autoStartPending=false;cancelStandby()});
if(document.body)bindStateObserver();else document.addEventListener('DOMContentLoaded',bindStateObserver,{once:true});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){bindStateObserver();tryAutoStart();scheduleStandby()}});
root.SynapPowerLifecycle={IDLE_TO_STANDBY_MS,MIN_SAFE_STANDBY_BUILD,get state(){return lastPowerState},get firmwareBuild(){return firmwareBuild},get autoStartPending(){return autoStartPending},schedule:scheduleStandby};
})(globalThis);
