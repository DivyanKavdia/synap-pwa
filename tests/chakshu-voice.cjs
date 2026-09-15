'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(setImmediate);
function fixture(){
  let now=10000,phase='connecting',fail=false,timerId=0;
  const calls=[],timers=new Map();
  const value=new DataView(new ArrayBuffer(20));[0xcd,1,1,1].forEach((n,i)=>value.setUint8(i,n));
  const characteristic={readValue:async()=>value,writeValueWithResponse:async()=>{},
    startNotifications:async()=>{},addEventListener(){},removeEventListener(){}};
  const context={canUse:()=>phase==='idle',canUseMedia:()=>['idle','recording'].includes(phase),
    mediaQueue:async(action,label)=>{calls.push(label);if(fail)throw Error('Native request failed.');return action();},
    service:{getCharacteristic:async()=>characteristic}};
  const c={Promise,Error,DataView,Uint8Array,Date:{now:()=>now},
    setTimeout(fn,ms){timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    addEventListener(){},document:{readyState:'loading',visibilityState:'visible',addEventListener(){},getElementById:()=>null},
    SynapDevices:{connection:context},SynapChakshu:{state:{owner:'account',available:true}},
    SynapCapabilities:{hasVoice:()=>true},SynapModules:{client:{module:{}}}};
  vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../devices/chakshu/voice.js'),'utf8'),c);
  return {api:c.SynapChakshuVoice,c,context,calls,timers,set phase(v){phase=v;},set fail(v){fail=v;},advance(ms){now+=ms;}};
}
test('voice discovery waits through handshakes and can restore commands during a recording',async()=>{
  const h=fixture();
  for(const phase of ['connecting','starting','stopping']){h.phase=phase;await h.api.sync();}
  assert.deepEqual(h.calls,[]);
  h.phase='recording';await h.api.sync();assert(h.calls.includes('Find voice control'));
  h.calls.length=0;h.phase='recording';h.advance(2000);await h.api.sync();
  assert.deepEqual(h.calls,['Set Chakshu voice controls','Check local voice status']);
});
test('media progress cannot turn a failed voice discovery into a retry burst',async()=>{
  const h=fixture();h.phase='idle';h.fail=true;await h.api.sync();
  for(let i=0;i<50;i++){await h.api.sync();await tick();}
  assert.deepEqual(h.calls,['Find voice control']);
  h.advance(2000);await h.api.sync();assert.equal(h.calls.length,2);
  assert.equal(h.timers.size,1);
});
test('a replacement connection can bind after old discovery finishes late',async()=>{
  const h=fixture();h.phase='idle';const service=h.context.service;let finish;
  h.context.service={getCharacteristic:()=>new Promise(resolve=>{finish=resolve;})};
  const old=h.api.sync();await tick();
  h.c.SynapDevices.connection={...h.context,service};await h.api.sync();
  finish(await service.getCharacteristic());await old;await tick();
  assert.equal(h.calls.filter(label=>label==='Find voice control').length,2);
  assert.equal(h.api.state.status,1);
});
