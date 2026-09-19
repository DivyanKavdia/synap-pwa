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
function packet({sequence=1,command=2,result=2,status=1,value=0}={}){
  const bytes=new Uint8Array(22),view=new DataView(bytes.buffer);
  bytes[0]=0xcd;bytes[1]=2;bytes[2]=status;bytes[3]=1;
  view.setUint32(4,sequence,true);bytes[8]=command;bytes[9]=result;
  view.setUint32(10,123,true);view.setUint32(14,4,true);view.setUint16(20,value,true);
  return view;
}
afterEach(()=>{
  for(const key of ['SynapCapabilities','SynapModules','SynapDevices','SynapChakshu','SynapChakshuVoice','dispatchEvent','CustomEvent'])delete global[key];
});

test('decodes the bounded single-model Chakshu voice protocol',()=>{
  const voice=load(),wake=voice.decode(packet({command:1})),stop=voice.decode(packet({command:8}));
  assert.equal(wake.command,1);assert.equal(voice.label(wake),'Hi ESP');
  assert.equal(voice.label(stop),'Stop');
  assert.throws(()=>voice.decode(packet({command:20})),/Unsupported/);
  assert.throws(()=>voice.decode(new DataView(new Uint8Array(20).buffer)),/Unsupported/);
});

test('voice perform is informational because firmware owns SD-first actions',async()=>{
  const voice=load();
  assert.deepEqual(await voice.perform(voice.decode(packet({command:2}))),{local:true,command:2});
  assert.deepEqual(await voice.perform(voice.decode(packet({command:3}))),{local:true,command:3});
});
