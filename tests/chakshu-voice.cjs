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

// One owner at a time: while the PWA holds the link the firmware wake engine is
// stood down and the control characteristic is never read again. The 1.9-second
// status + diagnostics poll this replaced was timing out on the shared media
// queue, stalling audio delivery and dropping the link with SD unmounted.
function connect({enabled = false, incoming = {}} = {}) {
  const ops = [];
  const control = {
    writeValueWithResponse(value) { ops.push('write:' + value[2]); return Promise.resolve(); },
    readValue() { ops.push('read'); return Promise.resolve(packet({enabled, ...incoming})); },
  };
  const diagnostics = { readValue() { ops.push('diagnostics'); return Promise.resolve(diagnosticPacket()); } };
  const context = {
    service: { getCharacteristic(uuid) { ops.push('find:' + uuid.slice(0, 8)); return Promise.resolve(uuid.endsWith('58-0000-1000-8000-00805f9b34fb') ? diagnostics : control); } },
    mediaQueue(action) { return Promise.resolve().then(action); },
  };
  global.SynapCapabilities = {hasVoice: () => true};
  global.SynapDevices = {connection: context};
  return {ops, context};
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('stands the wake engine down while the app owns the connection', async () => {
  const voice = load(), {ops} = connect();
  await voice.sync();
  await settle();
  // Disable, confirm, stop. No notification subscription, no diagnostics read.
  assert.deepEqual(ops, ['find:4fa12356', 'write:0', 'read']);
  assert.equal(voice.standDown, true);
  assert.equal(voice.state.enabled, false);
  // A stood-down device is never touched again, however often sync is called.
  await voice.sync();
  await voice.sync();
  await settle();
  assert.deepEqual(ops, ['find:4fa12356', 'write:0', 'read']);
});

test('surfaces the last completed offline photo or video after reconnect', async () => {
  let event;
  const voice = load();
  global.dispatchEvent = (value) => { if (value.type === 'synap-chakshu-voice-result') event = value.detail; };
  connect({ incoming: {sequence: 9, command: 2, result: 3, value: 0} });
  await voice.sync();
  await settle();
  assert.equal(voice.message, 'Offline photo saved to Chakshu SD.');
  assert.equal(event?.command, 2);
  assert.equal(event?.result, 3);
  assert.equal(event?.message, 'Offline photo saved to Chakshu SD.');

  // A bare wake word is explicit too: it never implies media capture.
  voice.release();
  global.SynapDevices.connection = null;
  await settle();
});

test('refuses to arm Hey Snap while the app is connected', async () => {
  const voice = load();
  connect();
  await voice.sync();
  await settle();
  await assert.rejects(() => voice.enabled(true), /only while Chakshu is disconnected/);
});

test('hands Hey Snap back when the app drops the link', async () => {
  const voice = load(), {ops} = connect();
  await voice.sync();
  await settle();
  ops.length = 0;
  voice.release();
  await settle();
  assert.deepEqual(ops, ['write:1']);
  assert.equal(voice.standDown, false);
});

test('reads voice diagnostics only when asked', async () => {
  const voice = load(), {ops} = connect();
  await voice.sync();
  await settle();
  ops.length = 0;
  const reading = await voice.diagnose();
  assert.equal(reading.candidateCount, 7);
  assert.deepEqual(ops, ['find:4fa12358', 'diagnostics']);
});


test('last offline result is persisted for the SD inbox', async () => {
  const voice = load();
  global.localStorage = (() => { const map=new Map(); return {getItem:(k)=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v))}; })();
  let event;
  global.dispatchEvent = (value) => { if (value.type === 'synap-chakshu-voice-result') event = value.detail; };
  connect({ incoming: {sequence: 12, command: 2, result: 3, value: 0} });
  await voice.sync();
  await settle();
  const last=voice.lastOutcome(global.SynapDevices.connection.deviceId);
  assert.equal(last?.message, 'Offline photo saved to Chakshu SD.');
  assert.equal(last?.command, 2);
  assert.equal(event?.message, last?.message);
});
