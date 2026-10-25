'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const codec=require('../audio-codec-v3.js');
const {Client,MediaWindow}=require('../devices/chakshu/transfer.js');
function crc(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
function block(offset=44,samples=800,total=3248){
 const p=new Uint8Array(426),v=new DataView(p.buffer);p[0]=0xcc;p[1]=1;p[2]=3;
 v.setUint32(4,7,true);v.setUint32(8,total,true);v.setUint32(12,offset,true);v.setUint16(16,samples,true);
 const pcm=Int16Array.from({length:800},(_,i)=>Math.round(Math.sin(i/30)*8000));
 p.set(codec.encodeFrame(pcm),18);v.setUint32(422,crc(p.subarray(0,422)),true);return v;
}
test('compressed blocks decode, trim the tail and never skip missing offsets',()=>{
 const state=new MediaWindow(7,44,3248,8,true,true);
 state.accept(block(1644));assert.equal(state.contiguous().next,44);
 state.accept(block());assert.equal(state.contiguous().next,3244);
 state.accept(block(3244,2));assert.equal(state.contiguous().next,3248);
 assert.equal(state.contiguous().parts[2].length,4);
 assert.deepEqual(state.contiguous().parts[0],codec.decodeFrame(new Uint8Array(block().buffer,18,404)));
 state.accept(block());assert.equal(state.chunks.size,3);
});
test('CRC protects payload and offsets; wrong sessions, overflow and unexpected compressed packets cannot import',()=>{
 const state=()=>new MediaWindow(7,44,3248,8,true,true);
 for(const i of [12,16,20,421]){const p=block();p.setUint8(i,p.getUint8(i)^1);assert.throws(()=>state().accept(p));}
 const p=block();p.setUint32(4,9,true);assert.equal(state().accept(p),false);
 assert.throws(()=>state().accept(block(3244,800)));
 assert.throws(()=>new MediaWindow(7,44,3248,8,true).accept(block()));
 assert.throws(()=>state().accept(block(45)));
});
test('only C3 media-v4 negotiates opcode36 with a connection-bound selection token',async()=>{
 for(const [id,mediaVersion,expected] of [[2,4,true],[2,3,false],[3,4,false],[1,4,false],[2,5,false]]){
  assert.equal(new Client({module:{id,mediaVersion},mediaFeatures:0x41}).compressedSupported,expected);
 }
 const c=new Client({module:{id:2,mediaVersion:4},mediaFeatures:0x41,queue:async f=>f()});let sent;
 c.command={properties:{writeWithoutResponse:false},async writeValueWithResponse(b){sent=b;}};
 await c.sendOnly(36,1644,undefined,7,'',6,20,99);
 assert.equal(sent.length,16);assert.equal(sent[1],36);
 assert.equal(new DataView(sent.buffer).getUint32(12,true),99);
});
test('lost compressed blocks resume from verified source offsets and small MTU falls back to original reads',async()=>{
 const c=new Client({module:{id:2,mediaVersion:4},mediaFeatures:1});
 c._request=async(op,offset)=>op===3?{total:3248,sessionToken:99}:{total:3248,offset,bytes:new Uint8Array(Math.min(480,3248-offset))};
 let offsets=[];c.window=async(offset)=>{offsets.push(offset);return offset===0?{parts:[new Uint8Array(44)],next:44}:{parts:[],next:offset};};
 c.sendOnly=async()=>{};
 const result=await c.file('/synap/test.WAV');assert.equal(result.size,3248);
 assert.deepEqual(offsets,[0,44,44,44]);assert.equal(c.streamDisabled,true);
});
