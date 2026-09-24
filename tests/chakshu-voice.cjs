'use strict';
const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');

function load(){
  delete require.cache[require.resolve('../devices/chakshu/voice.js')];
  delete global.SynapChakshuVoice;
  global.SynapCapabilities={hasVoice:()=>false};
  global.SynapModules={client:{module:null}};
  global.SynapDevices={connection:null};
  global.SynapChakshu={state:{owner:'u',available:true,storageReady:true}};
  global.dispatchEvent=()=>{};
  global.CustomEvent=class{constructor(type,init){this.type=type;this.detail=init?.detail}};
  require('../devices/chakshu/voice.js');
  return global.SynapChakshuVoice;
}
function packet({sequence=1,command=2,result=2,status=1,value=0,enabled=true}={}){
  const bytes=new Uint8Array(22),view=new DataView(bytes.buffer);
  bytes[0]=0xcd;bytes[1]=2;bytes[2]=status;bytes[3]=enabled?1:0;
  view.setUint32(4,sequence,true);bytes[8]=command;bytes[9]=result;
  view.setUint32(10,123,true);view.setUint32(14,4,true);view.setUint16(20,value,true);
  return view;
}
function diagnosticPacket({status=1,enabled=true,meanAbs=321,peak=2345,candidate=1,confidence=612,at=456,count=7,active=true}={}){
  const bytes=new Uint8Array(20),view=new DataView(bytes.buffer);
  bytes[0]=0xce;bytes[1]=1;bytes[2]=status;bytes[3]=enabled?1:0;
  view.setUint16(4,meanAbs,true);view.setUint16(6,peak,true);bytes[8]=candidate;
  view.setUint16(9,confidence,true);view.setUint32(11,at,true);view.setUint32(15,count,true);bytes[19]=active?1:0;
  return view;
}
afterEach(()=>{
  for(const key of ['SynapCapabilities','SynapModules','SynapDevices','SynapChakshu','SynapChakshuVoice','dispatchEvent','CustomEvent','localStorage'])delete global[key];
});

test('decodes the bounded single-model Chakshu voice protocol',()=>{
  const voice=load(),wake=voice.decode(packet({command:1})),stop=voice.decode(packet({command:8}));
  assert.equal(wake.command,1);assert.equal(voice.label(wake),'Hey Snap');
  assert.equal(voice.label(stop),'Stop');
  assert.throws(()=>voice.decode(packet({command:20})),/Unsupported/);
  assert.throws(()=>voice.decode(new DataView(new Uint8Array(20).buffer)),/Unsupported/);
});

test('voice perform remains informational because firmware owns SD voice actions',async()=>{
  const voice=load();
  assert.deepEqual(await voice.perform(voice.decode(packet({command:2}))),{local:true,command:2});
  assert.deepEqual(await voice.perform(voice.decode(packet({command:3}))),{local:true,command:3});
});

test('decodes Hey Snap classifier and microphone diagnostics',()=>{
  const voice=load(),d=voice.decodeDiagnostic(diagnosticPacket());
  assert.equal(d.meanAbs,321);assert.equal(d.peak,2345);assert.equal(d.candidate,1);
  assert.equal(d.confidence,0.612);assert.equal(d.candidateCount,7);assert.equal(d.active,true);
  assert.throws(()=>voice.decodeDiagnostic(new DataView(new Uint8Array(19).buffer)),/Unsupported/);
});

function connect({enabled=true,incoming={}}={}){
  const ops=[],listeners=new Set();
  let current=packet({enabled,...incoming});
  const control={
    writeValueWithResponse(value){ops.push('write:'+value[2]);current=packet({enabled:value[2]===1,sequence:incoming.sequence||1,command:incoming.command||0,result:incoming.result||0,value:incoming.value||0});return Promise.resolve()},
    readValue(){ops.push('read');return Promise.resolve(current)},
  };
  const events={
    startNotifications(){ops.push('notify');return Promise.resolve(events)},
    addEventListener(name,fn){ops.push('listen:'+name);listeners.add(fn)},
    removeEventListener(name,fn){ops.push('unlisten:'+name);listeners.delete(fn)},
    emit(value){for(const fn of listeners)fn({target:{value}})},
  };
  const diagnostics={readValue(){ops.push('diagnostics');return Promise.resolve(diagnosticPacket())}};
  const context={
    deviceId:'chakshu-test-1',
    service:{getCharacteristic(uuid){
      ops.push('find:'+uuid.slice(0,8));
      if(uuid.endsWith('57-0000-1000-8000-00805f9b34fb'))return Promise.resolve(events);
      if(uuid.endsWith('58-0000-1000-8000-00805f9b34fb'))return Promise.resolve(diagnostics);
      return Promise.resolve(control);
    }},
    mediaQueue(action){return Promise.resolve().then(action)},
  };
  global.SynapCapabilities={hasVoice:()=>true};
  global.SynapDevices={connection:context};
  return{ops,context,control,events};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));

test('BLE connection subscribes to Hey Snap events without disabling or polling the runtime',async()=>{
  const voice=load(),{ops}=connect();
  await voice.sync();await settle();
  assert.deepEqual(ops,[
    'find:4fa12356',
    'find:4fa12357',
    'listen:characteristicvaluechanged',
    'notify',
    'read',
  ]);
  assert.equal(voice.state.enabled,true);
  assert.equal(voice.standDown,false);
  await voice.sync();await voice.sync();await settle();
  assert.equal(ops.filter(x=>x==='read').length,1);
  assert.equal(ops.filter(x=>x.startsWith('write:')).length,0);
  assert.equal(ops.filter(x=>x==='notify').length,1);
});

test('connected Hey Snap completion is surfaced as an SD result',async()=>{
  let event;
  const voice=load();
  global.localStorage=(()=>{const map=new Map();return{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v))}})();
  global.dispatchEvent=value=>{if(value.type==='synap-chakshu-voice-result')event=value.detail};
  const {events}=connect();
  await voice.sync();await settle();
  events.emit(packet({sequence:9,command:2,result:3,value:0,enabled:true}));
  await settle();
  assert.equal(voice.message,'Photo saved to Chakshu SD.');
  assert.equal(event?.command,2);
  assert.equal(event?.result,3);
  assert.equal(event?.message,'Photo saved to Chakshu SD.');
  const last=voice.lastOutcome('chakshu-test-1');
  assert.equal(last?.message,'Photo saved to Chakshu SD.');
});

test('Hey Snap wake feedback remains live while BLE is connected',async()=>{
  const voice=load(),{events}=connect();
  await voice.sync();await settle();
  events.emit(packet({sequence:10,command:1,result:2,enabled:true}));
  await settle();
  assert.equal(voice.message,'Hey Snap heard · listening for command.');
});

test('voice audio and describe always report Chakshu SD storage',async()=>{
  const voice=load(),{events}=connect();
  await voice.sync();await settle();
  events.emit(packet({sequence:20,command:5,result:2,value:60}));
  await settle();
  assert.match(voice.message,/saving to Chakshu SD/);
  events.emit(packet({sequence:21,command:7,result:3,value:0}));
  await settle();
  assert.equal(voice.message,'Explain what you see photo saved to Chakshu SD. Sync it to generate the description.');
});

test('manual Hey Snap enable and disable remain diagnostic controls while connected',async()=>{
  const voice=load(),{ops}=connect();
  await voice.sync();await settle();
  ops.length=0;
  await voice.enabled(false);
  assert.deepEqual(ops,['write:0','read']);
  assert.equal(voice.state.enabled,false);
  ops.length=0;
  await voice.enabled(true);
  assert.deepEqual(ops,['write:1','read']);
  assert.equal(voice.state.enabled,true);
});

test('release performs no ownership write because firmware stays armed across disconnect',async()=>{
  const voice=load(),{ops}=connect();
  await voice.sync();await settle();
  ops.length=0;
  voice.release();await settle();
  assert.deepEqual(ops,[]);
});

test('reads voice diagnostics only when asked',async()=>{
  const voice=load(),{ops}=connect();
  await voice.sync();await settle();
  ops.length=0;
  const reading=await voice.diagnose();
  assert.equal(reading.candidateCount,7);
  assert.deepEqual(ops,['find:4fa12358','diagnostics']);
});
