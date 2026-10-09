'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const { Client }=require('../devices/chakshu/transfer.js');

test('separate PWA clients share a single BLE media transaction lease',async()=>{
  const link={},a=new Client(link),b=new Client(link);
  const events=[];
  let releaseA,enteredA;
  const entered=new Promise(resolve=>{enteredA=resolve});
  const held=new Promise(resolve=>{releaseA=resolve});
  a._request=async()=>{events.push('A start');enteredA();await held;events.push('A end');return 'A'};
  b._request=async()=>{events.push('B start');return 'B'};
  const first=a.request(7);
  await entered;
  const second=b.request(3);
  await Promise.resolve();
  assert.deepEqual(events,['A start'],'second client must not overwrite active response');
  releaseA();
  assert.equal(await first,'A');
  assert.equal(await second,'B');
  assert.deepEqual(events,['A start','A end','B start']);
});

test('rejected first transaction does not strand the shared link',async()=>{
  const link={},a=new Client(link),b=new Client(link);
  a._request=async()=>{throw Error('transient SD failure')};
  b._request=async()=>42;
  await assert.rejects(a.request(7),/transient SD failure/);
  assert.equal(await b.request(3),42);
});

test('independent BLE links cannot block each other',async()=>{
  const a=new Client({}),b=new Client({});
  let release;
  a._request=()=>new Promise(resolve=>{release=resolve});
  b._request=async()=>99;
  const waiting=a.request(7);
  await Promise.resolve();
  assert.equal(await b.request(3),99);
  release(1);
  assert.equal(await waiting,1);
});

function buildClearScenario(catalogueFailure=false){
  const source=fs.readFileSync(path.join(root,'devices/chakshu/capture-preview.js'),'utf8');
  const begin=source.indexOf('  async function clearSD() {');
  const end=source.indexOf('  async function formatSD() {',begin);
  assert(begin>=0&&end>begin);
  const storage=new Map([
    ['synap-chakshu-move-v2:SYNAP-123456ABCDEF:/synap/record101.wav','verified'],
    ['synap-chakshu-move-v2:SYNAP-OTHER:/synap/other.wav','other']
  ]);
  const events=[];
  const context={
    busy:false,
    root:{SynapAppControls:{recordingState:()=>({active:false})}},
    api:()=>({
      state:{offline:false,session:null},
      async catalogue(){events.push('catalogue');if(catalogueFailure)throw Error('unreadable');return[
        {path:'/synap/record101.wav',bytes:12344}
      ]},
      async refreshSD(){events.push('unsafe remount')}
    }),
    context:()=>({deviceId:'SYNAP-123456ABCDEF'}),
    client:()=>({async request(op){events.push('clear '+op);return {total:100}}}),
    localStorage:{
      get length(){return storage.size},
      key(index){return [...storage.keys()][index]},
      getItem(key){return storage.get(key)},
      removeItem(key){storage.delete(key)}
    },
    reportSDStage(...args){events.push(['diagnostic',...args])},
    Error
  };
  vm.runInNewContext(source.slice(begin,end)+';globalThis.clearSD=clearSD;',context);
  return {context,storage,events};
}

for(const fail of [false,true]){
  test('bounded clear retains synced receipts after '+(fail?'catalogue failure':'partial deletion'),async()=>{
    const {context,storage,events}=buildClearScenario(fail);
    const removed=await context.clearSD();
    assert.equal(removed,100);
    assert.equal(storage.size,2);
    assert.deepEqual(events.map(x=>typeof x==='string'?x:x[0]),
      fail?['clear 18','catalogue','diagnostic']:['clear 18','catalogue']);
  });
}
