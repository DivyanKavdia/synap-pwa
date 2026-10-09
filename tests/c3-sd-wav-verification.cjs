'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../devices/chakshu/capture-preview.js'),'utf8');
const begin=source.indexOf('async function normalizedImportedWav(source) {'),
  end=source.indexOf('async function verifyReceipt(receipt) {',begin);
assert(begin>=0 && end>begin,'WAV normalization must be defined before receipt verification');
const fragment=source.slice(begin,end);
const digest=async blob=>crypto.createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
let savedBlob=null;
const record={id:'c3-test',sealed:true};
const ctx={Blob,Uint8Array,DataView,Error,digest,audioJournal:()=>({
  async get(store,id){assert.equal(store,'recordings');assert.equal(id,'c3-test');return record},
  async blob(){return savedBlob},
})};
vm.createContext(ctx);
vm.runInContext(fragment+'\nthis.api={normalizedImportedWav,verifyAudio};',ctx);
function wav(pcmBytes){
 const h=new Uint8Array(44),v=new DataView(h.buffer);
 const tag=(i,text)=>{for(let n=0;n<text.length;n++)h[i+n]=text.charCodeAt(n)};
 tag(0,'RIFF');tag(8,'WAVE');tag(12,'fmt ');tag(36,'data');
 v.setUint32(4,pcmBytes+36,true);v.setUint32(16,16,true);
 v.setUint16(20,1,true);v.setUint16(22,1,true);
 v.setUint32(24,16000,true);v.setUint32(28,32000,true);
 v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,pcmBytes,true);
 const pcm=new Uint8Array(pcmBytes);
 for(let i=0;i<pcm.length;i++)pcm[i]=i%251;
 return new Blob([h,pcm],{type:'audio/wav'});
}
test('C3 2,473,984-byte SD WAV verifies despite exact journal frame padding',async()=>{
 const original=wav(2473940);
 assert.equal(original.size,2473984);
 savedBlob=await ctx.api.normalizedImportedWav(original);
 assert.equal(savedBlob.size,2475244);
 const result=await ctx.api.verifyAudio('c3-test',original);
 assert.equal(result.bytes,2475244);
 assert.equal(result.sha256,await digest(savedBlob));
});
test('a byte modification or nonzero padding is rejected; SD original stays unverified',async()=>{
 const original=wav(3410), expected=await ctx.api.normalizedImportedWav(original);
 const broken=new Uint8Array(await expected.arrayBuffer());
 broken[113]^=1;
 savedBlob=new Blob([broken]);
 await assert.rejects(ctx.api.verifyAudio('c3-test',original),/did not match the SD source/);
 const padded=new Uint8Array(await expected.arrayBuffer());
 padded[padded.length-1]=1;
 savedBlob=new Blob([padded]);
 await assert.rejects(ctx.api.verifyAudio('c3-test',original),/did not match the SD source/);
});
test('already frame-aligned WAV preserves exact bytes; corrupt headers are rejected',async()=>{
 const original=wav(3200);
 assert.equal(await ctx.api.normalizedImportedWav(original),original);
 savedBlob=original;
 assert.equal((await ctx.api.verifyAudio('c3-test',original)).bytes,original.size);
 const mutated=new Uint8Array(await original.arrayBuffer());
 new DataView(mutated.buffer).setUint32(40,3100,true);
 await assert.rejects(ctx.api.normalizedImportedWav(new Blob([mutated])),/Invalid imported PCM WAV/);
});
test('sync receipts store reconstructed WAV hash and byte count, not original SD bytes',()=>{
 assert.match(source,/verifiedAudio = await verifyAudio\(record\.id, source\.main\)/);
 assert.match(source,/audioBytes: verifiedAudio\.bytes, audioSha256: verifiedAudio\.sha256/);
 assert.match(source,/mainBytes: source\.main\.size/);
 assert.match(source,/mainSha256: mainSha/);
});
