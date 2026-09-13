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
