'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
require('../audio-store.js');
function wav(value){return DKAudioCodec.wav([new Uint8Array(1600).fill(value)]);}
function api(enhancement){
  const context={Blob,DOMException,console,setTimeout,clearTimeout,URL,AbortController,DKAudioCodec,SynapAudioEnhancement:enhancement};
  context.globalThis=context;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../synap-backend.js'),'utf8'),context);
  return context.SynapBackend;
}
function journal(meta){
  const store={meta,get:async()=>store.meta,atomic:async(_names,fn)=>new Promise((resolve,reject)=>{
    let result;
    fn({segments:{get:()=>{const request={result:store.meta};queueMicrotask(()=>{request.onsuccess();resolve(result)});return request},put:value=>{store.meta=value}}},value=>{result=value},{abort:()=>reject(new Error('aborted'))});
  })};
  return store;
}
test('new uploads persist the original WAV and never call automatic enhancement',async()=>{
  const original=wav(1),journalStore=journal({recordingId:'r',index:0,pcmBlob:original,notes:'preserved'});
  const client=api({prepareForUpload:async()=>{throw Error('Automatic denoising must not run');}});
  const job={recordingId:'r',segmentIndex:0};
  assert.equal(await client.transcriptionAudio(journalStore,job,original),original);
  assert.equal(journalStore.meta.transcriptionBlob,original);
  assert.equal(await client.transcriptionAudio(journalStore,job,original),original);
  assert.equal(journalStore.meta.pcmBlob,original);assert.equal(journalStore.meta.notes,'preserved');
});
test('legacy cached bodies remain identical because an earlier upload may already be accepted',async()=>{
  const original=wav(1),legacy=wav(2),store=journal({recordingId:'r',index:0,pcmBlob:original,transcriptionBlob:legacy});
  const result=await api().transcriptionAudio(store,{recordingId:'r',segmentIndex:0},original);
  assert.equal(result,legacy);assert.equal(store.meta.pcmBlob,original);
});
test('invalid original and cached WAVs are retained but never submitted for transcription',async()=>{
  const bad=new Blob([new Uint8Array(45)]),job={recordingId:'r',segmentIndex:0};
  for(const meta of [{recordingId:'r',index:0},{recordingId:'r',index:0,transcriptionBlob:bad}]){
    const store=journal(meta);
    await assert.rejects(api().transcriptionAudio(store,job,bad),{code:'audio_integrity',retryable:false});
    assert.equal(store.meta,meta);
  }
});
test('cancelled uploads do not read or persist a source body',async()=>{
  const signal=AbortSignal.abort();
  const store={get:async()=>{throw Error('Cancelled job must not start');}};
  await assert.rejects(api().transcriptionAudio(store,{recordingId:'r',segmentIndex:0},wav(1),signal),{name:'AbortError'});
});
