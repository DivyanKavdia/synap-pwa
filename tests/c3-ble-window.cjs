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
