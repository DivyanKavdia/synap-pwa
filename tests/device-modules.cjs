'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {decode,decodeStatus,legacy,Client,UUID,PROFILES}=require('../device-modules.js');
function descriptor(id=3) {
  const view=new DataView(new ArrayBuffer(20));
  [0xC7,1,id,1].forEach((v,i)=>view.setUint8(i,v));
  view.setUint16(4,911,true);view.setUint16(6,911,true);
  view.setUint16(8,0x3660,true);view.setUint16(10,16000,true);
  view.setUint8(12,8);view.setUint8(13,8);return view;
}
function status(operation=0,id=0,state=0) {
  const view=new DataView(new ArrayBuffer(20));
  [0xC9,1,operation,id,state,0,7,0].forEach((v,i)=>view.setUint8(i,v));
  view.setUint32(8,1900,true);view.setUint32(12,1800,true);return view;
}
test('detects three modules from firmware IDs and rejects malformed or unknown descriptors',()=>{
  for(const id of [1,2,3])assert.equal(decode(descriptor(id)).target,PROFILES[id].target);
  const info=decode(descriptor());assert.equal(info.name,'Chakshu');assert.equal(info.sensor,0x3660);
  assert.equal(info.flashMiB,8);assert.equal(info.sampleRate,16000);
  assert.throws(()=>decode(descriptor(4)),/not recognized/);
  const bad=descriptor();bad.setUint8(1,2);assert.throws(()=>decode(bad),/Unsupported/);
  assert.throws(()=>decode(new DataView(new ArrayBuffer(19))),/Unsupported/);
  const readiness=descriptor();readiness.setUint16(6,0xffff,true);assert.throws(()=>decode(readiness),/readiness/);
  assert.equal(legacy('SYNAP-FW:esp32c3-supermini-4m:synap-os1-build1200:1200').name,'synap C3');
  assert.equal(legacy('synap-Chakshu'),null);
  assert.equal(legacy('SYNAP-FW:xiao-esp32s3-sense-8m:synap-os1-build0:0'),null);
});
test('SD status reports actual capacity and rejects impossible values',()=>{
  assert.equal(decodeStatus(status()).freeMiB,1800);
  const bad=status();bad.setUint32(12,2000,true);assert.throws(()=>decodeStatus(bad),/capacity/);
  const progress=status();progress.setUint8(7,101);assert.throws(()=>decodeStatus(progress),/Invalid/);
});
test('all requests use the connection queue and cannot run during audio or another SD job',async()=>{
  let allowed=true,writes=0,queueCalls=0,current=status();
  const path=new TextEncoder().encode('');
  const chars={
    [UUID]:{readValue:async()=>descriptor()},
    '4fa12352-0000-1000-8000-00805f9b34fb':{readValue:async()=>current},
    '4fa12353-0000-1000-8000-00805f9b34fb':{readValue:async()=>new DataView(path.buffer)},
    '4fa12351-0000-1000-8000-00805f9b34fb':{writeValueWithResponse:async bytes=>{
      ++writes;assert.deepEqual([...bytes].slice(0,3),[0xC8,1,3]);current=status(3,bytes[3],1);
    }}
  };
  const context={canUse:()=>allowed,service:{getCharacteristic:async uuid=>chars[uuid]},
    queue:async action=>{++queueCalls;return action();}};
  const client=new Client(context);assert.equal(await client.refresh(),true);
  allowed=false;await assert.rejects(client.run(3),/Finish/);assert.equal(writes,0);
  allowed=true;await client.run(3);assert.equal(writes,1);assert.equal(client.busy,true);
  await assert.rejects(client.run(2),/Wait/);assert(queueCalls>=6);
  client.close();await assert.rejects(client.read(UUID),/changed/);
});
test('a disconnect during discovery never updates another connection or rejects the poll loop',async()=>{
  let release;
  const blocked=new Promise(resolve=>release=resolve);
  const client=new Client({canUse:()=>true,queue:action=>action(),service:{
    getCharacteristic:async()=>{await blocked;return {readValue:async()=>descriptor()};}
  }});
  const pending=client.refresh();client.close();release();
  assert.equal(await pending,false);assert.equal(client.module,null);
});

test('an ATT write response is not mistaken for firmware acceptance or successful capture',async()=>{
  let result=status(),written=0;
  const empty=new DataView(new ArrayBuffer(0));
  const client=new Client({canUse:()=>true,queue:action=>action(),service:{getCharacteristic:async uuid=>({
    readValue:async()=>uuid===UUID?descriptor():uuid.includes('352-')?result:empty,
    writeValueWithResponse:async()=>{written++;}
  })}});
  await client.refresh();await client.run(2);
  assert.equal(client.busy,true);
  await client.refresh();assert.equal(client.busy,true,'wait for matching application result');
  client.expected.deadline=0;
  await client.refresh();
  assert.equal(client.busy,false);
  assert.match(client.error,/did not confirm/);
  assert.equal(written,1,'never automatically repeat a capture after ambiguous acceptance');
});
