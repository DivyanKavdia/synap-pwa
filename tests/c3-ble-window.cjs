'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Client,MediaWindow}=require('../devices/chakshu/transfer.js');
const source=fs.readFileSync(path.join(__dirname,'../devices/chakshu/transfer.js'),'utf8');
test('C3 BLE window appends explicit WAV path without changing legacy ten-byte commands',async()=>{
 const writes=[];
 const client=new Client({mediaFeatures:1,queue:async fn=>fn(),service:{}});
 client.command={properties:{writeWithoutResponse:false},
   async writeValueWithResponse(value){writes.push(new Uint8Array(value));}};
 await client.sendOnly(12,960,undefined,17,'/synap/c3_take.wav');
 await client.sendOnly(12,0,undefined,18);
 assert.equal(writes[0].length,10+'/synap/c3_take.wav'.length);
 assert.equal(new DataView(writes[0].buffer).getUint32(6,true),960);
 assert.equal(new TextDecoder().decode(writes[0].subarray(10)),'/synap/c3_take.wav');
 assert.equal(writes[1].length,10,'Chakshu window remains wire compatible');
});
test('window receiver validates contiguous positions and detects missing chunks',()=>{
 const state=new MediaWindow(7,0,1440);
 function packet(kind,offset,data=[]){
   const b=new Uint8Array(16+data.length),v=new DataView(b.buffer);
   b[0]=0xcc;b[1]=1;b[2]=kind;
   v.setUint32(4,7,true);v.setUint32(8,1440,true);v.setUint32(12,offset,true);
   b.set(data,16);return v;
 }
 assert.equal(state.accept(packet(1,0,new Uint8Array(480).fill(1))),true);
 assert.equal(state.accept(packet(1,960,new Uint8Array(480).fill(3))),true);
 assert.equal(state.contiguous().next,480,'missing offset 480 must not be skipped');
 assert.equal(state.accept(packet(1,480,new Uint8Array(480).fill(2))),true);
 assert.equal(state.accept(packet(2,1440)),true);
 assert.equal(state.ended,true);
 assert.equal(state.contiguous().next,1440);
});
test('C3 fast mode is feature-gated with no-recording and small-MTU fallback',()=>{
 assert.match(source,/if \(this\.features & 1 && !this\.streamDisabled\)/);
 assert.match(source,/this\.window\(size, first\.total, signal, c3WindowPath\)/);
 assert(source.includes('c3WindowPath = op === 3 && /\\.wav$/i.test(path)'));
 assert.match(source,/this\.streamDisabled = true/);
 assert.match(source,/const reply = await this\._request\(readOp, size, readPath, signal\)/);
 assert.match(source,/this\.context\.module\?\.id === 2/);
});

test('C3 slow-start credits cap at 12 and repeated losses use legacy op12 without SD writes',()=>{
 assert.match(source,/this\.fastCredits = 8/);
 assert.match(source,/Math\.min\(12, this\.fastCredits\)/);
 assert.match(source,/Math\.min\(12, credits \+ 1\)/);
 assert.match(source,/if \(\+\+this\.fastWindowFailures >= 3\) this\.fastDisabled = true/);
 assert.match(source,/this\.sendOnly\(fast \? 30 : 12/);
 assert.match(source,/fallbackToLegacy: this\.fastDisabled/);
});
test('C3 SD notification errors are explicit while Chakshu errors keep legacy compatibility',()=>{
 const state=new MediaWindow(99,0,480,12,true);
 const bytes=new Uint8Array(16),v=new DataView(bytes.buffer);
 bytes[0]=0xcc;bytes[1]=1;bytes[2]=2;bytes[3]=7;
 v.setUint32(4,99,true);v.setUint32(8,480,true);v.setUint32(12,0,true);
 assert.throws(()=>state.accept(v),e=>e.mediaCode===7 && e.sdReadFailure===true &&
   /do not format or delete/.test(e.message));
 const legacy=new MediaWindow(99,0,480);
 assert.throws(()=>legacy.accept(v),e=>e.mediaCode===7 && !e.sdReadFailure);
});

test('C3 contiguous full credits finish without END; a missing packet cannot advance',()=>{
 const state=new MediaWindow(777,0,5760,12,true);
 const pkt=offset=>{
  const b=new Uint8Array(496),v=new DataView(b.buffer);
  b[0]=0xcc;b[1]=1;b[2]=1;
  v.setUint32(4,777,true);v.setUint32(8,5760,true);v.setUint32(12,offset,true);
  return v;
 };
 for(let i=0;i<12;i++)if(i!==4)state.accept(pkt(i*480));
 assert.equal(state.creditComplete(12),false);
 state.accept(pkt(4*480));
 assert.equal(state.creditComplete(12),true);
 assert.equal(state.contiguous().next,5760);
 assert.equal(state.ended,false);
 assert.match(source,/window\.ended \|\| \(fast && window\.creditComplete\(credits\)\)/);
 assert.match(source,/notificationWaitMs/);
});
