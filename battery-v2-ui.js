/* Synap battery telemetry v2 compatibility/UI.
   V1 remains supported by touch-event-bridge.js. V2 adds ADC mV + raw counts. */
(function(root){'use strict';
const MAGIC=0xB7,VERSION=2;
let last=null;
const previousMemoryInspect=root.SynapMemoryEventBridge?.inspect?.bind(root.SynapMemoryEventBridge);
const previousBattery=root.SynapBatteryBridge||{};
const previousBatteryInspect=previousBattery.inspect?.bind(previousBattery);

function parse(event){
  try{
    const v=event?.target?.value;
    if(!v||v.byteLength!==12||v.getUint8(0)!==MAGIC||v.getUint8(1)!==VERSION)return null;
    const flags=v.getUint8(3);
    return {
      version:VERSION,
      percent:v.getUint8(2),
      available:Boolean(flags&1),
      low:Boolean(flags&2),
      critical:Boolean(flags&4),
      millivolts:v.getUint16(4,true),
      lowThresholdMv:v.getUint16(6,true),
      adcMillivolts:v.getUint16(8,true),
      adcRaw:v.getUint16(10,true),
      receivedAt:Date.now()
    };
  }catch(error){console.warn('[synap battery v2] parse failed',error);return null}
}

function isDisconnected(){
  const body=document.body;
  if(!body)return true;
  if(body.dataset.deviceState==='0')return true;
  return body.dataset.state==='disconnected'||body.dataset.state==='unsupported';
}
function renderDisconnected(){
  const button=document.getElementById('headerBatteryStatus');
  if(button){
    const value=button.querySelector('.synap-battery-value');
    const fill=button.querySelector('.synap-battery-fill');
    button.dataset.state='disconnected';
    if(value)value.textContent='';
    if(fill)fill.style.width='0px';
    button.setAttribute('aria-label','Pendant disconnected');
  }
  const pop=document.getElementById('synapBatteryPopover');
  if(pop){
    const big=pop.querySelector('.synap-battery-big');
    const state=pop.querySelector('.synap-battery-state');
    const meter=pop.querySelector('.synap-battery-meter>span');
    const help=pop.querySelector('.synap-battery-help');
    if(big)big.textContent='—';
    if(state)state.textContent='Disconnected';
    if(meter)meter.style.width='0%';
    if(help)help.textContent='Connect the pendant to read battery status.';
  }
  if(document.body)document.body.dataset.batteryPercent='';
}
function syncConnectionUi(){
  if(isDisconnected())renderDisconnected();
  else if(last)render(last,false);
}
function render(detail,notify=true){
  last=detail;
  if(isDisconnected()){
    renderDisconnected();
    if(notify)root.dispatchEvent(new CustomEvent('synap-battery-status',{detail}));
    return;
  }
  previousBattery.ensureBatteryUi?.();
  const percent=Math.max(0,Math.min(100,Number(detail.percent)||0));
  const button=document.getElementById('headerBatteryStatus');
  if(button){
    const value=button.querySelector('.synap-battery-value');
    const fill=button.querySelector('.synap-battery-fill');
    if(detail.available){
      button.dataset.state=detail.critical?'critical':detail.low?'low':'good';
      if(value)value.textContent=percent+'%';
      if(fill)fill.style.width=Math.max(1,Math.round(percent*.17))+'px';
      button.setAttribute('aria-label','Pendant battery '+percent+' percent');
    }else{
      button.dataset.state='unknown';
      if(value)value.textContent='—';
      if(fill)fill.style.width='0px';
      button.setAttribute('aria-label','Pendant battery percentage unavailable');
    }
  }
  const pop=document.getElementById('synapBatteryPopover');
  if(pop){
    const big=pop.querySelector('.synap-battery-big');
    const state=pop.querySelector('.synap-battery-state');
    const meter=pop.querySelector('.synap-battery-meter>span');
    const help=pop.querySelector('.synap-battery-help');
    if(detail.available){
      if(big)big.textContent=percent+'%';
      if(state)state.textContent=detail.critical?'Critical':detail.low?'Low':'Healthy';
      if(meter)meter.style.width=percent+'%';
    }else{
      if(big)big.textContent='—';
      if(state)state.textContent='Percentage unavailable';
      if(meter)meter.style.width='0%';
    }
    if(help)help.textContent=detail.available?'Estimated battery charge.':'Battery reading is outside the expected range. Check the GPIO1 divider; details are in Diagnostics.';
  }
  if(document.body){
    document.body.dataset.batteryPercent=detail.available?String(detail.percent):'';
    document.body.dataset.batteryMillivolts=String(detail.millivolts||0);
    document.body.dataset.batteryAdcMillivolts=String(detail.adcMillivolts||0);
    document.body.dataset.batteryAdcRaw=String(detail.adcRaw||0);
  }
  if(notify){
    console.info('[synap battery v2]',detail);
    root.dispatchEvent(new CustomEvent('synap-battery-status',{detail}));
  }
}

function inspectV2(event){
  const detail=parse(event);
  if(!detail)return false;
  render(detail);
  return true;
}

function memoryInspect(event){
  if(inspectV2(event))return true;
  return previousMemoryInspect?previousMemoryInspect(event):false;
}
function batteryInspect(event){
  if(inspectV2(event))return true;
  return previousBatteryInspect?previousBatteryInspect(event):false;
}

function installConnectionObserver(){
  const start=()=>{
    if(!document.body)return;
    syncConnectionUi();
    new MutationObserver(syncConnectionUi).observe(document.body,{attributes:true,attributeFilter:['data-device-state','data-state']});
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
}

if(root.SynapMemoryEventBridge)root.SynapMemoryEventBridge.inspect=memoryInspect;
root.SynapBatteryBridge={
  MAGIC,
  VERSION,
  get status(){return last||previousBattery.status||null},
  inspect:batteryInspect,
  ensureBatteryUi:previousBattery.ensureBatteryUi,
  open:previousBattery.open,
  close:previousBattery.close
};
root.SynapBatteryV2={MAGIC,VERSION,parse,get status(){return last}};
installConnectionObserver();
root.addEventListener('synap-gatt-disconnected',()=>{
  last=null;
  renderDisconnected();
});
})(globalThis);
