'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Client,COMMITTED_MESSAGE}=require('../ota.js');
const app=fs.readFileSync('app.js','utf8');
const media=fs.readFileSync('devices/chakshu/media.js','utf8');
const sw=fs.readFileSync('sw.js','utf8');
const html=fs.readFileSync('index.html','utf8');

test('OTA protocol 3 committed state is visible but prevents a new flash session',async()=>{
  const v=new DataView(new ArrayBuffer(20));
  v.setUint8(0,0xD7);v.setUint8(1,3);v.setUint8(2,5);v.setUint32(4,123,true);
  v.setUint32(8,818896,true);v.setUint32(12,1310720,true);
  v.setUint16(16,503,true);v.setUint16(18,1908,true);
  const info=[], writes=[];
  const ota=new Client({
    connected:()=>true,queue:fn=>fn(),onStatus:s=>info.push(s),
    getService:async()=>({getCharacteristic:async uuid=>{
      if(uuid.includes('12348'))return {writeValueWithResponse:async x=>writes.push(x)};
      if(uuid.includes('12349'))return {addEventListener(){},removeEventListener(){},startNotifications:async()=>{},readValue:async()=>v};
      if(uuid.includes('1234c'))return {readValue:async()=>new TextEncoder().encode('SYNAP-8CFD4949687C')};
      throw Error('unexpected UUID');
    }})
  });
  const status=await ota.check();
  assert.equal(status.state,5);
  assert.equal(status.build,1908);
  assert.equal(status.deviceId,'SYNAP-8CFD4949687C');
  const binary={size:512,arrayBuffer:async()=>new ArrayBuffer(512)};
  await assert.rejects(ota.update(binary,status.deviceId),error=>error.message===COMMITTED_MESSAGE);
  assert.equal(writes.length,0,'already-committed image is never overwritten');
  assert(info.some(item=>item.state===5));
});

test('PWA stops automatic SD activity and points the user to physical power restart',()=>{
  assert.match(app,/if\(info\.state===5\) \{[\s\S]*?COMMITTED_MESSAGE/);
  assert.match(app,/if\(running\.state===5\)/);
  assert.match(app,/verificationError\.otaPendingRestart/);
  assert.match(app,/delete document\.body\.dataset\.otaCommitted/);
  assert.match(media,/dataset\.otaCommitted === 'true'/);
  assert.match(media,/SD operations are paused/);
  assert.match(COMMITTED_MESSAGE,/disconnect USB power/);
  for(const source of [app,sw,html]) assert(source.includes('1.0.0-shell199-c3-sd-fault-report'));
  assert(html.includes('ota.js?v=1.0.0-c3-committed-restart1'));
});
