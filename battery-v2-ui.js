/* Synap battery telemetry v2 compatibility/UI.
   V1 remains supported by touch-event-bridge.js. V2 adds ADC mV + raw counts. */
(function(root){'use strict';
const MAGIC=0xB7,VERSION=2;
let last=null;
const CALIBRATION_KEY='synap-odyssey-c3-full-adc-v1:';
const FULL_CELL_MV=4200;
// An optional *display-only* one-point estimate. Never change firmware's
// validity, critical-battery shutdown, raw diagnostics, or BLE packet.
function currentOdysseyId(){
  const id=root.SynapDevices?.connection?.deviceId;
  const module=root.SynapModules?.client?.module;
  return module?.id===2 && /^SYNAP-[0-9A-F]{12}$/.test(id||'')?id:null;
}
function fullChargeAdc(){
  const id=currentOdysseyId();if(!id)return null;
  try{
    const value=Number(root.localStorage?.getItem(CALIBRATION_KEY+id));
    return Number.isInteger(value)&&value>=800&&value<=2700?value:null;
  }catch(_){return null}
}
function percentFromEstimatedCell(mv){
  if(mv>=4180)return 100; // 20 mV plateau avoids 99/100 jitter at full charge.
  if(mv>=4050)return 90+Math.floor((mv-4050)*10/150);
  if(mv>=3950)return 80+Math.floor((mv-3950)/10);
  if(mv>=3850)return 70+Math.floor((mv-3850)/10);
  if(mv>=3780)return 60+Math.floor((mv-3780)*10/70);
  if(mv>=3720)return 50+Math.floor((mv-3720)*10/60);
  if(mv>=3680)return 40+Math.floor((mv-3680)/4);
  if(mv>=3620)return 30+Math.floor((mv-3620)/6);
  if(mv>=3550)return 20+Math.floor((mv-3550)*10/70);
  if(mv>=3450)return 10+Math.floor((mv-3450)/10);
  if(mv>=3300)return Math.floor((mv-3300)/15);
  return 0;
}
function empiricalEstimate(detail,fullAdc=fullChargeAdc()){
  if(!detail || detail.available || !fullAdc)return null;
  const adc=Number(detail.adcMillivolts);
  if(!Number.isInteger(adc)||adc<=0)return null;
  // One-point calibration assumes Vadc is proportional to Vcell.
  // Fail closed for physically impossible results; never fake firmware telemetry.
  const mv=Math.round(adc*FULL_CELL_MV/fullAdc);
  if(mv<2800||mv>4350)return null;
  return {percent:percentFromEstimatedCell(mv),millivolts:mv,fullAdc,
    source:'unverified-device-local-estimate'};
}
function ensureCalibrationControls(){
  const pop=document.getElementById('synapBatteryPopover');
  if(!pop||typeof document.createElement!=='function'||typeof pop.appendChild!=='function')return null;
  let controls=document.getElementById('synapBatteryCalibrationControls');
  if(controls)return controls;
  controls=document.createElement('div');
  controls.id='synapBatteryCalibrationControls';
  controls.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin-top:12px';
  const set=document.createElement('button');
  set.type='button';set.className='button button-small';
  set.textContent='Set current reading as 100% estimate';
  set.addEventListener('click',()=>{
    const id=currentOdysseyId(),adc=last?.adcMillivolts;
    if(!id||!last||last.available||!Number.isInteger(adc)||adc<800||adc>2700)return;
    try{root.localStorage?.setItem(CALIBRATION_KEY+id,String(adc));}
    catch(e){console.warn('[synap battery] calibration not saved',e);return}
    render(last,false);
  });
  const reset=document.createElement('button');
  reset.type='button';reset.className='button button-small';
  reset.textContent='Reset estimate';
  reset.addEventListener('click',()=>{
    const id=currentOdysseyId();if(!id)return;
    try{root.localStorage?.removeItem(CALIBRATION_KEY+id);}
    catch(e){console.warn('[synap battery] calibration reset failed',e);return}
    render(last,false);
  });
  controls.appendChild(set);controls.appendChild(reset);pop.appendChild(controls);
  controls._set=set;controls._reset=reset;
  return controls;
}
function updateCalibrationControls(){
  const controls=ensureCalibrationControls();if(!controls)return;
  const id=currentOdysseyId(),saved=fullChargeAdc();
  const eligible=Boolean(id&&last&&!last.available&&Number.isInteger(last.adcMillivolts)&&
    last.adcMillivolts>=800&&last.adcMillivolts<=2700);
  controls.hidden=!id||(!saved&&!eligible);
  controls._set.hidden=!eligible;
  controls._reset.hidden=!saved;
}
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
    if(fill)fill.style.width='0%';
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
  if(document.body){
    document.body.dataset.batteryPercent='';
    document.body.dataset.batteryEstimatedPercent='';
  }
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
  const estimate=empiricalEstimate(detail);
  const displayed=detail.available||Boolean(estimate);
  const percent=Math.max(0,Math.min(100,
    Number(detail.available?detail.percent:estimate?.percent)||0));
  updateCalibrationControls();
  const button=document.getElementById('headerBatteryStatus');
  if(button){
    const value=button.querySelector('.synap-battery-value');
    const fill=button.querySelector('.synap-battery-fill');
    if(displayed){
      button.dataset.state=estimate?'unknown':detail.critical?'critical':detail.low?'low':'good';
      if(value)value.textContent=percent+'%';
      if(fill)fill.style.width=percent+'%';
      button.setAttribute('aria-label','Pendant battery '+(estimate?'estimated ':'')+percent+' percent');
    }else{
      button.dataset.state='unknown';
      if(value)value.textContent='—';
      if(fill)fill.style.width='0%';
      button.setAttribute('aria-label','Pendant battery percentage unavailable');
    }
  }
  const pop=document.getElementById('synapBatteryPopover');
  if(pop){
    const big=pop.querySelector('.synap-battery-big');
    const state=pop.querySelector('.synap-battery-state');
    const meter=pop.querySelector('.synap-battery-meter>span');
    const help=pop.querySelector('.synap-battery-help');
    if(displayed){
      if(big)big.textContent=percent+'%';
      if(state)state.textContent=estimate?'Estimated · unverified':detail.critical?'Critical':detail.low?'Low':'Healthy';
      if(meter)meter.style.width=percent+'%';
    }else{
      if(big)big.textContent='—';
      if(state)state.textContent='Percentage unavailable';
      if(meter)meter.style.width='0%';
    }
    if(help)help.textContent=estimate?
      'Display estimate from this pendant’s full-charge ADC reading. Firmware still reports the sensor as invalid; confirm the resistor divider and GPIO1 with a multimeter.':
      detail.available?'Estimated battery charge.':
      'Battery reading is outside the expected range. Check the battery divider; details are in Diagnostics. You can set a temporary 100% display reference while fully charged.';
  }
  if(document.body){
    document.body.dataset.batteryPercent=detail.available?String(detail.percent):'';
    document.body.dataset.batteryEstimatedPercent=estimate?String(percent):'';
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
root.SynapBatteryV2={MAGIC,VERSION,parse,empiricalEstimate,percentFromEstimatedCell,
  get status(){return last},get estimate(){return empiricalEstimate(last)}};
installConnectionObserver();
root.addEventListener('synap-device-identified',()=>{if(last)render(last,false)});
root.addEventListener('synap-module-changed',()=>{if(last)render(last,false)});
root.addEventListener('synap-gatt-disconnected',()=>{
  last=null;
  renderDisconnected();
});
})(globalThis);
