'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Client}=require('../devices/chakshu/transfer.js');
test('C3 SD sync requests lossless opcode31 and preserves every byte including final partial packet',async()=>{
 const input=Uint8Array.from({length:9002},(_,i)=>(i*73+i%11)&255);
 const c=new Client({module:{id:2,mediaVersion:4},mediaFeatures:0x41});
 const stream=new EventTarget();c.subscribeStream=async()=>{c.stream=stream;};
 c._request=async op=>{assert.equal(op,3);return {total:input.length,sessionToken:99};};
 const operations=[];
 c.sendOnly=async(op,offset,signal,id,path,credits,pace,token)=>{
  operations.push(op);assert.equal(op,31);assert.equal(token,99);assert.equal(path,'');
  assert(credits<=10&&pace>=10);
  for(let n=0;n<credits&&offset<input.length;n++){
   const bytes=input.slice(offset,offset+480),p=new Uint8Array(16+bytes.length),v=new DataView(p.buffer);
   p[0]=0xcc;p[1]=1;p[2]=1;v.setUint32(4,id,true);v.setUint32(8,input.length,true);v.setUint32(12,offset,true);p.set(bytes,16);
   const event=new Event('characteristicvaluechanged');Object.defineProperty(event,'target',{value:{value:v}});stream.dispatchEvent(event);offset+=bytes.length;
  }
  const p=new Uint8Array(16),v=new DataView(p.buffer);p[0]=0xcc;p[1]=1;p[2]=2;v.setUint32(4,id,true);v.setUint32(8,input.length,true);v.setUint32(12,offset,true);
  const event=new Event('characteristicvaluechanged');Object.defineProperty(event,'target',{value:{value:v}});stream.dispatchEvent(event);
 };
 const blob=await c.file('/synap/test.WAV');
 assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),input);assert.equal(blob.synapTransferEncoding,'original');assert(operations.length>1);
});
test('only SD v4 opts into faster PCM and repeated loss restores conservative transfer',()=>{
 for(const [id,mediaVersion,reliable] of [[2,4,false],[2,3,true],[2,1,true],[3,4,false]]){
  const c=new Client({module:{id,mediaVersion},mediaFeatures:0x41});assert.equal(c.reliableC3SdMode,reliable);assert.equal(c.compressedSupported,false);
 }
 const c=new Client({module:{id:2,mediaVersion:4},mediaFeatures:0x41});
 for(let i=0;i<40;i++)c.adaptWindow(true,false,c.fastCredits,150,true,true);
 assert.equal(c.fastPaceMs,10);assert.equal(c.fastCredits,10);
 for(let i=0;i<3;i++)c.adaptWindow(false,true,c.fastCredits,150,true,true);
 assert.equal(c.fastPaceMs,15);assert.equal(c.fastCredits,6);assert.equal(c.fastDisabled,true);
});
