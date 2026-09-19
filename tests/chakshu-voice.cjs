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
  assert.equal(wake.command,1);assert.equal(voice.label(wake),'Hey Snap');
  assert.equal(voice.label(stop),'Stop');
  assert.throws(()=>voice.decode(packet({command:20})),/Unsupported/);
  assert.throws(()=>voice.decode(new DataView(new Uint8Array(20).buffer)),/Unsupported/);
});

test('voice perform is informational because firmware owns SD-first actions',async()=>{
  const voice=load();
  assert.deepEqual(await voice.perform(voice.decode(packet({command:2}))),{local:true,command:2});
  assert.deepEqual(await voice.perform(voice.decode(packet({command:3}))),{local:true,command:3});
});

function diagnosticPacket({status=1,enabled=true,meanAbs=321,peak=2345,candidate=1,confidence=612,at=456,count=7,active=true}={}){
  const bytes=new Uint8Array(20),view=new DataView(bytes.buffer);
  bytes[0]=0xce;bytes[1]=1;bytes[2]=status;bytes[3]=enabled?1:0;
  view.setUint16(4,meanAbs,true);view.setUint16(6,peak,true);bytes[8]=candidate;
  view.setUint16(9,confidence,true);view.setUint32(11,at,true);view.setUint32(15,count,true);bytes[19]=active?1:0;
  return view;
}
test('decodes Hey Snap classifier and microphone diagnostics',()=>{
  const voice=load(),d=voice.decodeDiagnostic(diagnosticPacket());
  assert.equal(d.meanAbs,321);assert.equal(d.peak,2345);assert.equal(d.candidate,1);
  assert.equal(d.confidence,0.612);assert.equal(d.candidateCount,7);assert.equal(d.active,true);
  assert.throws(()=>voice.decodeDiagnostic(new DataView(new Uint8Array(19).buffer)),/Unsupported/);
});


function diagnosticPacketV2({
  status=1,enabled=true,meanAbs=120,peak=500,candidate=3,confidence=910,at=456,count=12,active=true,
  noiseFloor=180,speechThreshold=440,vadRun=2,holdActive=true,maxMeanAbs=720,vadOpenCount=4,
  acceptedCommand=1,acceptedConfidence=930,acceptedAt=444,acceptedCount=2
}={}){
  const bytes=new Uint8Array(44),view=new DataView(bytes.buffer);
  bytes[0]=0xce;bytes[1]=2;bytes[2]=status;bytes[3]=enabled?1:0;
  view.setUint16(4,meanAbs,true);view.setUint16(6,peak,true);bytes[8]=candidate;
  view.setUint16(9,confidence,true);view.setUint32(11,at,true);view.setUint32(15,count,true);bytes[19]=active?1:0;
  view.setUint16(20,noiseFloor,true);view.setUint16(22,speechThreshold,true);bytes[24]=vadRun;bytes[25]=holdActive?1:0;
  view.setUint16(26,maxMeanAbs,true);view.setUint32(28,vadOpenCount,true);bytes[32]=acceptedCommand;
  view.setUint16(33,acceptedConfidence,true);view.setUint32(35,acceptedAt,true);view.setUint32(39,acceptedCount,true);
  return view;
}
test('decodes v2 VAD and accepted-command diagnostics while preserving v1',()=>{
  const voice=load(),d=voice.decodeDiagnostic(diagnosticPacketV2());
  assert.equal(d.diagnosticVersion,2);
  assert.equal(d.noiseFloor,180);assert.equal(d.speechThreshold,440);assert.equal(d.vadRun,2);assert.equal(d.holdActive,true);
  assert.equal(d.maxMeanAbs,720);assert.equal(d.vadOpenCount,4);
  assert.equal(d.acceptedCommand,1);assert.equal(d.acceptedConfidence,0.93);assert.equal(d.acceptedAtMs,444);assert.equal(d.acceptedCount,2);
  assert.equal(voice.decodeDiagnostic(diagnosticPacket()).diagnosticVersion,1);
  assert.throws(()=>voice.decodeDiagnostic(diagnosticPacketV2({acceptedCommand:20})),/Unsupported/);
});
