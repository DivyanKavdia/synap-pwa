'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');

function packet(version=2) {
  const bytes=version===1?32:48;
  const value=new DataView(new ArrayBuffer(bytes+10),5,bytes);
  value.setUint8(0,0xD6);value.setUint8(1,version);value.setUint8(2,7);value.setUint8(3,9);
  [120,2,4,1,96000,80000,450].forEach((n,i)=>value.setUint32(4+i*4,n,true));
  if(version===2){
    value.setUint16(32,8,true);value.setUint16(34,7,true);
    value.setUint32(36,3,true);value.setUint32(40,430500,true);value.setUint32(44,0x103,true);
  }
  return value;
}
function harness(state='idle') {
  const handlers={},health={textContent:''},logNode={textContent:'',scrollHeight:0},calls=[];
  const c={console:{log(){}},Date,JSON,Set,Math,Boolean,Error,Number,DataView,
    diagnosticLines:[],ui:{diagnosticsLog:logNode},
    document:{readyState:'loading',body:{dataset:{state}},addEventListener(){},
      getElementById:id=>id==='pendantHealth'?health:id==='diagnosticsLog'?logNode:null},
    addEventListener:(name,fn)=>{handlers[name]=fn},
    dispatchEvent:event=>handlers[event.type]?.(event),
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}},
    SynapDevices:{connection:{
      queue:async (action,label)=>{calls.push(label);return action()},
      service:{getCharacteristic:async()=>({readValue:async()=>packet()})}
    }}
  };
  c.window=c;vm.createContext(c);
  const app=read('app.js');
  vm.runInContext(app.slice(app.indexOf('  function log('),app.indexOf('  function toast(')),c);
  vm.runInContext(read('enhancements.js').replace('globalThis.SynapEnhancements={decodePendantDiagnostics}',
    'globalThis.SynapEnhancements={decodePendantDiagnostics,readPendantDiagnostics}'),c);
  return {c,calls,health,logNode,api:c.SynapEnhancements};
}

test('legacy and new pendant diagnostics decode without losing reset or heap evidence',()=>{
  const {api}=harness();
  const old=api.decodePendantDiagnostics(packet(1)),next=api.decodePendantDiagnostics(packet());
  assert.equal(old.resetText,'Brownout');assert.equal(old.notifyRejects,4);assert.equal(old.freeHeap,96000);
  assert.equal(old.disconnects,undefined);
  for(const key of Object.keys(old))assert.equal(next[key],old[key],key);
  assert.equal(next.disconnectReason,8);assert.equal(next.disconnectText,'Link supervision timeout');
  assert.equal(next.disconnects,3);assert.equal(next.lastDisconnectMs,430500);assert.equal(next.notifyError,0x103);
});

test('absent, truncated and unknown-version diagnostics cannot fabricate link evidence',()=>{
  const {api}=harness();
  for(const bytes of [0,1,16,31,33,47,49])
    assert.throws(()=>api.decodePendantDiagnostics(new DataView(new ArrayBuffer(bytes))),/Unsupported/);
  const unknown=packet();unknown.setUint8(1,3);
  assert.throws(()=>api.decodePendantDiagnostics(unknown),/Unsupported/);
  const unavailable=packet();unavailable.setUint16(32,65535,true);
  assert.equal(api.decodePendantDiagnostics(unavailable).disconnectText,'Reason unavailable');
  unavailable.setUint32(36,0,true);
  assert.equal(api.decodePendantDiagnostics(unavailable).disconnectText,'No disconnect since boot');
});

test('NimBLE HCI reasons retain their namespace and distinguish a host disconnect from radio timeout',()=>{
  const {api}=harness(),v=packet();
  for(const [reason,text] of [[0x213,'Remote host ended connection'],[0x208,'Link supervision timeout'],
    [0x216,'Local host ended connection'],[0x222,'Link response timeout'],[0x23b,'Unacceptable connection parameters']]){
    v.setUint16(32,reason,true);const data=api.decodePendantDiagnostics(v);
    assert.equal(data.disconnectReason,reason);assert.equal(data.disconnectText,text);
  }
  v.setUint16(32,0x113,true);assert.equal(api.decodePendantDiagnostics(v).disconnectText,'BLE reason 0x113');
});

test('Chakshu boot and last-link evidence decodes alongside unchanged recording counters',()=>{
  const {api}=harness(),base=packet(),v=new DataView(new ArrayBuffer(72));
  new Uint8Array(v.buffer).set(new Uint8Array(base.buffer,base.byteOffset,base.byteLength));
  v.setUint8(1,3);v.setUint8(2,0xc3);
  v.setUint32(48,1320,true);v.setUint32(52,480,true);v.setUint32(56,7300,true);
  v.setUint16(60,24,true);v.setUint16(62,0,true);v.setUint16(64,600,true);
  v.setUint8(66,2);v.setUint8(67,3);v.setUint32(68,3400,true);
  const data=api.decodePendantDiagnostics(v);
  assert.equal(data.bootReadyMs,1320);assert.equal(data.mediaBootMs,480);
  assert.equal(data.lastLinkDurationMs,7300);assert.equal(data.linkDurationMs,3400);
  assert.equal(data.lastLinkIntervalMs,30);assert.equal(data.lastLinkSupervisionMs,6000);
  assert.equal(data.lastLinkStage,'audio-subscribed');assert.equal(data.linkStage,'status-requested');
  assert.equal(data.firmwareDsp,'none');assert.equal(data.audioTransport,'pcm16');
  assert.equal(data.captured,120);assert.equal(data.freeHeap,96000);
  v.setUint8(66,5);assert.throws(()=>api.decodePendantDiagnostics(v),/Unsupported pendant link stage/);
});

test('firmware diagnostics survive subsequent app logs and are included in Copy diagnostics',async()=>{
  const h=harness();await h.api.readPendantDiagnostics();
  assert.deepEqual(h.calls,['Find pendant diagnostics','Read pendant diagnostics']);
  assert.match(h.logNode.textContent,/"disconnectReason":8/);
  h.c.log('Recording saved');
  assert.match(h.logNode.textContent,/"disconnects":3/);
  assert.equal(h.logNode.textContent,h.c.diagnosticLines.join('\n'));
  assert.match(h.health.textContent,/Last reset: Brownout/);
  assert.match(h.health.textContent,/3 drops · 4 notify rejects/);
});

test('supervision diagnostics distinguish a submitted request from the actual negotiated timeout',()=>{
  const {api}=harness(),base=packet(),v=new DataView(new ArrayBuffer(100),8,84);
  new Uint8Array(v.buffer,v.byteOffset,v.byteLength).set(new Uint8Array(base.buffer,base.byteOffset,base.byteLength));
  v.setUint8(1,4);v.setUint16(64,72,true);v.setUint8(67,3);
  v.setUint16(72,24,true);v.setUint16(74,0,true);v.setUint16(76,72,true);
  v.setUint8(78,1);v.setUint8(79,3);v.setUint16(80,0,true);v.setUint16(82,15,true);
  let data=api.decodePendantDiagnostics(v);
  assert.equal(data.linkIntervalMs,30);assert.equal(data.linkLatency,0);
  assert.equal(data.linkSupervisionMs,720);assert.equal(data.lastLinkSupervisionMs,720);
  assert.equal(data.linkParamRequests,1);assert.equal(data.lastLinkParamRequests,3);
  assert.equal(data.linkParamRequestCode,0);assert.equal(data.lastLinkParamRequestCode,15);
  v.setUint16(76,600,true);data=api.decodePendantDiagnostics(v);
  assert.equal(data.linkSupervisionMs,6000);assert.equal(data.lastLinkSupervisionMs,720);
  v.setUint8(78,0);v.setUint16(80,65535,true);
  assert.equal(api.decodePendantDiagnostics(v).linkParamRequestCode,null);
  for(const length of [72,80,83,85]){
    const bad=new DataView(new ArrayBuffer(length));bad.setUint8(0,0xd6);bad.setUint8(1,4);
    assert.throws(()=>api.decodePendantDiagnostics(bad),/Unsupported/);
  }
});

test('diagnostic reads cannot add GATT traffic while recording or updating',async()=>{
  for(const state of ['starting','recording','stopping','saving','updating','connecting','disconnected']){
    const h=harness(state);await h.api.readPendantDiagnostics();assert.equal(h.calls.length,0,state);
  }
});

test('starting capture during diagnostic discovery cancels the remaining read',async()=>{
  const h=harness();
  h.c.SynapDevices.connection.service.getCharacteristic=async()=>{
    h.c.document.body.dataset.state='starting';
    return {readValue:async()=>{throw Error('must not read during capture')}};
  };
  await h.api.readPendantDiagnostics();assert.deepEqual(h.calls,['Find pendant diagnostics']);
  assert.equal(h.c.diagnosticLines.length,0);
});

test('only a firmware capability flag can establish unfiltered capture',()=>{
  const {api}=harness();
  assert.equal(api.decodePendantDiagnostics(packet()).firmwareDsp,'unknown');
  const current=packet();current.setUint8(2,0x47);
  assert.equal(api.decodePendantDiagnostics(current).firmwareDsp,'none');
  assert.equal(api.decodePendantDiagnostics(current).realMic,true);
  assert.equal(api.decodePendantDiagnostics(current).audioTransport,'adpcm');
  current.setUint8(2,0xC7);
  assert.equal(api.decodePendantDiagnostics(current).audioTransport,'pcm16');
  const legacy=packet(1);legacy.setUint8(2,0x47);
  assert.equal(api.decodePendantDiagnostics(legacy).firmwareDsp,'unknown');
});
