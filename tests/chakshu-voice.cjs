'use strict';
const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');

function load(){
  delete require.cache[require.resolve('../devices/chakshu/voice.js')];
  delete global.SynapChakshuVoice;
  global.SynapCapabilities={hasVoice:()=>false};
  global.SynapModules={client:{module:null}};
  global.SynapDevices={connection:null};
  global.SynapChakshu={state:{owner:'u',available:true,storageReady:true},setAudio:async()=>{},stop:async()=>{}};
  global.SynapChakshuV2={startOffline:async()=>{},describeNow:async()=>{},moveSD:async()=>({visualId:'v'})};
  global.SynapChakshuTransfer={Client:class{async savedPreview(){return{path:'/synap/aaaaaaaa-bbbbbbbb.jpg'}}}};
  require('../devices/chakshu/voice.js');
  return global.SynapChakshuVoice;
}
function packet({sequence=1,command=2,result=2,status=1,value=0}={}){
  const bytes=new Uint8Array(22),view=new DataView(bytes.buffer);
  bytes[0]=0xcd;bytes[1]=2;bytes[2]=status;bytes[3]=1;
  view.setUint32(4,sequence,true);bytes[8]=command;bytes[9]=result;
  view.setUint32(10,123,true);view.setUint32(14,4,true);view.setUint16(20,value,true);
  return view;
}
afterEach(()=>{
  for(const key of ['SynapCapabilities','SynapModules','SynapDevices','SynapChakshu','SynapChakshuV2','SynapChakshuTransfer','SynapChakshuVoice'])delete global[key];
});

test('decodes only bounded Chakshu voice protocol v2 status',()=>{
  const voice=load(),wake=voice.decode(packet({command:1})),decoded=voice.decode(packet({command:155,value:600}));
  assert.equal(wake.command,1);assert.equal(voice.label(wake),'Hey Synap');
  assert.equal(decoded.sequence,1);assert.equal(decoded.command,155);assert.equal(decoded.value,600);assert.equal(decoded.drops,4);
  assert.throws(()=>voice.decode(new DataView(new Uint8Array(20).buffer)),/Unsupported/);
  const bad=packet();bad.setUint8(1,1);assert.throws(()=>voice.decode(bad),/Unsupported/);
  const invalid=packet();invalid.setUint8(8,19);assert.throws(()=>voice.decode(invalid),/Unsupported/);
});

test('dispatches default and explicit video durations to high-detail SD recording',async()=>{
  const voice=load(),calls=[];
  global.SynapChakshuV2.startOffline=async(...args)=>calls.push(args);
  await voice.perform(voice.decode(packet({command:3})));
  await voice.perform(voice.decode(packet({sequence:2,command:20,value:1})));
  await voice.perform(voice.decode(packet({sequence:3,command:155,value:600})));
  assert.deepEqual(calls,[[0,10],[0,1],[0,600]]);
  assert.equal(voice.label(voice.decode(packet({command:20,value:1}))),'Record for 1 seconds');
});

test('dispatches audio, stop, explicit vision and verified full-quality snap',async()=>{
  const voice=load(),calls=[];
  global.SynapChakshu.setAudio=async(value)=>calls.push(['audio',value]);
  global.SynapChakshu.stop=async()=>calls.push(['stop']);
  global.SynapChakshuV2.describeNow=async()=>calls.push(['describe']);
  global.SynapDevices.connection={deviceId:'SYNAP-001122334455'};
  global.SynapChakshuTransfer.Client=class{async savedPreview(){calls.push(['preview']);return{path:'/synap/aaaaaaaa-bbbbbbbb.jpg'}}};
  global.SynapChakshuV2.moveSD=async(path)=>{calls.push(['move',path]);return{visualId:'visual-1'}};
  await voice.perform(voice.decode(packet({command:5})));
  await voice.perform(voice.decode(packet({command:6})));
  await voice.perform(voice.decode(packet({command:4})));
  await voice.perform(voice.decode(packet({command:7})));
  const id=await voice.perform(voice.decode(packet({command:2})));
  assert.equal(id,'visual-1');
  assert.deepEqual(calls,[['audio',true],['audio',false],['stop'],['describe'],['preview'],['move','/synap/aaaaaaaa-bbbbbbbb.jpg']]);
});