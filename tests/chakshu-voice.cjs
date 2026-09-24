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
  global.addEventListener=()=>{};
  global.CustomEvent=class{constructor(type,init){this.type=type;this.detail=init?.detail}};
  require('../devices/chakshu/voice.js');
  return global.SynapChakshuVoice;
}
function packet({sequence=0,command=0,result=0,status=1,value=0,enabled=true}={}){
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
  for(const key of ['SynapCapabilities','SynapModules','SynapDevices','SynapChakshu','SynapChakshuVoice','dispatchEvent','addEventListener','CustomEvent','localStorage'])delete global[key];
});

test('decodes the bounded single-model Chakshu voice protocol',()=>{
  const voice=load(),wake=voice.decode(packet({sequence:1,command:1})),stop=voice.decode(packet({sequence:2,command:8}));
  assert.equal(wake.command,1);assert.equal(voice.label(wake),'Hey Snap');
  assert.equal(voice.label(stop),'Stop');
  assert.throws(()=>voice.decode(packet({command:20})),/Unsupported/);
  assert.throws(()=>voice.decode(new DataView(new Uint8Array(20).buffer)),/Unsupported/);
});

test('voice perform remains device-local because Hey Snap always saves to SD',async()=>{
  const voice=load();
  assert.deepEqual(await voice.perform(voice.decode(packet({sequence:1,command:2}))),{local:true,command:2});
  assert.deepEqual(await voice.perform(voice.decode(packet({sequence:2,command:3}))),{local:true,command:3});
});

test('decodes Hey Snap classifier and microphone diagnostics',()=>{
  const voice=load(),d=voice.decodeDiagnostic(diagnosticPacket());
  assert.equal(d.meanAbs,321);assert.equal(d.peak,2345);assert.equal(d.candidate,1);
  assert.equal(d.confidence,0.612);assert.equal(d.candidateCount,7);assert.equal(d.active,true);
  assert.throws(()=>voice.decodeDiagnostic(new DataView(new Uint8Array(19).buffer)),/Unsupported/);
});

function connect({enabled=true,incoming={}}={}){
  const ops=[],listeners=new Set();
  const control={
    writeValueWithResponse(value){ops.push('write:'+value[2]);return Promise.resolve();},
    readValue(){ops.push('read');return Promise.resolve(packet({enabled,...incoming}));},
  };
  const events={
    addEventListener(name,fn){if(name==='characteristicvaluechanged')listeners.add(fn);},
    removeEventListener(name,fn){if(name==='characteristicvaluechanged')listeners.delete(fn);},
    startNotifications(){ops.push('voice-notify');return Promise.resolve();},
    emit(value){for(const fn of listeners)fn({target:{...events,value}});},
  };
  const diagnostics={readValue(){ops.push('diagnostics');return Promise.resolve(diagnosticPacket());}};
  const context={
    deviceId:'chakshu-test-1',
    service:{getCharacteristic(uuid){
      ops.push('find:'+uuid.slice(0,8));
      if(uuid.endsWith('57-0000-1000-8000-00805f9b34fb'))return Promise.resolve(events);
      if(uuid.endsWith('58-0000-1000-8000-00805f9b34fb'))return Promise.resolve(diagnostics);
      return Promise.resolve(control);
    }},
    mediaQueue(action){return Promise.resolve().then(action);},
  };
  global.SynapCapabilities={hasVoice:()=>true};
  global.SynapDevices={connection:context};
  return {ops,context,events,listeners};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));

test('keeps Hey Snap enabled while connected and subscribes exactly once',async()=>{
  const voice=load(),{ops}=connect();
  await voice.sync();await settle();
  assert.deepEqual(ops,['find:4fa12356','find:4fa12357','voice-notify','write:1','read']);
  assert.equal(voice.standDown,false);
  assert.equal(voice.state.enabled,true);
  await voice.sync();await voice.sync();await settle();
  assert.deepEqual(ops,['find:4fa12356','find:4fa12357','voice-notify','write:1','read']);
});

test('surfaces connected Hey Snap SD completion notifications without polling',async()=>{
  let event;
  const voice=load(),{ops,events}=connect();
  global.dispatchEvent=value=>{if(value.type==='synap-chakshu-voice-result')event=value.detail;};
  await voice.sync();await settle();
  ops.length=0;
  events.emit(packet({sequence:9,command:2,result:3}));
  assert.equal(voice.message,'Voice photo saved to Chakshu SD.');
  assert.equal(event?.command,2);
  assert.equal(event?.result,3);
  assert.equal(event?.message,'Voice photo saved to Chakshu SD.');
  assert.deepEqual(ops,[],'voice results arrive by notification, not status polling');
});

test('voice commands report SD intent both online and offline',async()=>{
  let event;
  const voice=load(),{events}=connect();
  global.dispatchEvent=value=>{if(value.type==='synap-chakshu-voice-result')event=value.detail;};
  await voice.sync();await settle();
  events.emit(packet({sequence:20,command:5,result:2,value:60}));
  assert.equal(voice.message,'Voice audio accepted · saving to Chakshu SD for up to 60 seconds.');
  events.emit(packet({sequence:21,command:5,result:3,value:0}));
  assert.equal(event?.message,'Voice audio saved to Chakshu SD.');
  const describe=voice.decode(packet({sequence:22,command:7,result:3}));
  assert.equal(voice.label(describe),'Explain what you see');
});

test('Hey Snap cannot be disabled by the connected PWA',async()=>{
  const voice=load(),{ops}=connect();
  await voice.sync();await settle();
  await assert.rejects(()=>voice.enabled(false),/always enabled/);
  const before=ops.length;
  const state=await voice.enabled(true);
  assert.equal(state.enabled,true);
  assert.deepEqual(ops.slice(before),['write:1','read']);
});

test('release detaches the browser listener without a voice ownership write',async()=>{
  const voice=load(),{ops,listeners}=connect();
  await voice.sync();await settle();
  assert.equal(listeners.size,1);
  ops.length=0;
  voice.release();
  assert.equal(listeners.size,0);
  assert.deepEqual(ops,[]);
});

test('reads voice diagnostics only when explicitly asked',async()=>{
  const voice=load(),{ops}=connect();
  await voice.sync();await settle();
  ops.length=0;
  const reading=await voice.diagnose();
  assert.equal(reading.candidateCount,7);
  assert.deepEqual(ops,['find:4fa12358','diagnostics']);
});

test('last completed voice SD result is persisted for the SD inbox',async()=>{
  const voice=load(),{events}=connect();
  global.localStorage=(()=>{const map=new Map();return{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v))};})();
  let event;
  global.dispatchEvent=value=>{if(value.type==='synap-chakshu-voice-result')event=value.detail;};
  await voice.sync();await settle();
  events.emit(packet({sequence:12,command:2,result:3}));
  const last=voice.lastOutcome(global.SynapDevices.connection.deviceId);
  assert.equal(last?.message,'Voice photo saved to Chakshu SD.');
  assert.equal(last?.command,2);
  assert.equal(event?.message,last?.message);
  events.emit(packet({sequence:13,command:1,result:2}));
  assert.equal(voice.lastOutcome(global.SynapDevices.connection.deviceId)?.sequence,12,'wake feedback does not replace last capture result');
});
