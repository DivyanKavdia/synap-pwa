'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function element(){
  return {
    children:[],textContent:'',style:{},dataset:{},hidden:false,
    setAttribute(k,v){this[k]=v},
    addEventListener(name,cb){(this.listeners||=( {}))[name]=cb},
    appendChild(el){this.children.push(el);if(el.id)nodes[el.id]=el},
    click(){this.listeners?.click?.()}
  };
}
const nodes={};
const parts={};
for(const key of ['.synap-battery-value','.synap-battery-fill',
    '.synap-battery-big','.synap-battery-state',
    '.synap-battery-meter>span','.synap-battery-help'])parts[key]=element();
const button=element(),popover=element();
button.querySelector=popover.querySelector=(selector)=>parts[selector];
nodes.headerBatteryStatus=button;
nodes.synapBatteryPopover=popover;
const body={dataset:{state:'idle',deviceState:'1'}};
const storage=new Map(),listeners={};
const context={
  document:{body,readyState:'complete',getElementById:id=>nodes[id]||null,createElement:element},
  localStorage:{
    getItem:k=>storage.has(k)?storage.get(k):null,
    setItem:(k,v)=>storage.set(k,v),
    removeItem:k=>storage.delete(k)
  },
  SynapDevices:{connection:{deviceId:'SYNAP-123456ABCDEF'}},
  SynapModules:{client:{module:{id:2}}},
  SynapBatteryBridge:{ensureBatteryUi(){}},
  MutationObserver:class{observe(){}},
  CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}},
  addEventListener:(type,fn)=>{listeners[type]=fn},
  dispatchEvent(){},console:{info(){},warn(){}}
};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../battery-v2-ui.js'),'utf8'),context);
function receive(adcMv,cellMv=7047,percent=0,flags=0){
  const data=new DataView(new ArrayBuffer(12));
  data.setUint8(0,0xB7);data.setUint8(1,2);data.setUint8(2,percent);data.setUint8(3,flags);
  data.setUint16(4,cellMv,true);data.setUint16(8,adcMv,true);data.setUint16(10,3054,true);
  assert.equal(context.SynapBatteryBridge.inspect({target:{value:data}}),true);
}
receive(2253);
assert.equal(parts['.synap-battery-value'].textContent,'—','invalid raw input stays unavailable without opt-in');
assert.equal(nodes.synapBatteryCalibrationControls.hidden,false);
const control=nodes.synapBatteryCalibrationControls;
assert.equal(control.children[0].hidden,false,'100% calibration offered for the connected C3');
control.children[0].click();
assert.equal(parts['.synap-battery-value'].textContent,'100%');
assert.equal(parts['.synap-battery-big'].textContent,'100%');
assert.match(parts['.synap-battery-state'].textContent,/unverified/);
assert.equal(context.SynapBatteryV2.status.millivolts,7047,'raw firmware voltage remains preserved');
assert.equal(context.SynapBatteryV2.status.available,false,'firmware validity stays false');
assert.equal(body.dataset.batteryPercent,'','estimated percent must not impersonate trusted telemetry');
assert.equal(body.dataset.batteryEstimatedPercent,'100');
receive(2252,7043);
assert.equal(parts['.synap-battery-value'].textContent,'100%','jitter around the anchor stays at 100%');
receive(2100,6568);
assert(Number.parseInt(parts['.synap-battery-value'].textContent,10)<100,
  'the estimate must not freeze at 100% after a material ADC decline');
assert.equal(context.SynapBatteryV2.status.millivolts,6568);
receive(2253,4200,91,1);
assert.equal(parts['.synap-battery-value'].textContent,'91%','trusted firmware percent takes precedence');
receive(2253);
context.SynapDevices.connection.deviceId='SYNAP-AAAABBBBCCCC';
listeners['synap-device-identified']();
assert.equal(parts['.synap-battery-value'].textContent,'—','the estimate cannot cross device identities');
context.SynapDevices.connection.deviceId='SYNAP-123456ABCDEF';
context.SynapModules.client.module.id=3;
listeners['synap-module-changed']();
assert.equal(parts['.synap-battery-value'].textContent,'—','the estimate cannot affect Chakshu/S3');
context.SynapModules.client.module.id=2;
listeners['synap-module-changed']();
assert.equal(parts['.synap-battery-value'].textContent,'100%');
control.children[1].click();
assert.equal(parts['.synap-battery-value'].textContent,'—','reset restores invalid raw state');
assert.equal(storage.size,0);
console.log('PASS per-device C3 battery display calibration, invalid-data safety and 100% jitter');
