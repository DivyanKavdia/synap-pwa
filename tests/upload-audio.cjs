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
test('new uploads preserve exact source bytes across retry/reload and never run enhancement',async()=>{
  const original=wav(1),journalStore=journal({recordingId:'r',index:0,pcmBlob:original,notes:'preserved'});
  let calls=0;const job={recordingId:'r',segmentIndex:0};
  const client=()=>api({prepareForUpload:async()=>{calls++;throw Error('Automatic enhancement is forbidden')}});
  assert.equal(await client().transcriptionAudio(journalStore,job,original),original);
  assert.equal(journalStore.meta.pcmBlob,original);
  assert.equal(journalStore.meta.transcriptionAudioPolicy,'source-pcm-v1');
  const retry=await client().transcriptionAudio(journalStore,job,wav(2));
  assert.deepEqual(await retry.arrayBuffer(),await original.arrayBuffer());
  assert.equal(calls,0);assert.equal(journalStore.meta.notes,'preserved');
});
test('pending pre-upgrade bodies remain identical because the server may already have accepted them',async()=>{
  const original=wav(1),prepared=wav(2),store=journal({recordingId:'r',index:0,pcmBlob:original,transcriptionBlob:prepared});
  const result=await api({}).transcriptionAudio(store,{recordingId:'r',segmentIndex:0},original);
  assert.equal(result,prepared);assert.equal(store.meta.pcmBlob,original);
  assert.notEqual(store.meta.transcriptionAudioPolicy,'source-pcm-v1','do not relabel legacy processing as source audio');
});
test('a competing legacy request selected inside the transaction keeps its bytes and provenance',async()=>{
  const original=wav(1),prepared=wav(2),store=journal({recordingId:'r',index:0});
  const atomic=store.atomic;
  store.atomic=async(...args)=>{store.meta.transcriptionBlob=prepared;return atomic(...args)};
  assert.equal(await api({}).transcriptionAudio(store,{recordingId:'r',segmentIndex:0},original),prepared);
  assert.equal(store.meta.transcriptionAudioPolicy,'legacy-prepared');
});
test('corrupt source and cached WAVs are rejected without modifying original PCM',async()=>{
  const original=wav(1),bad=new Blob([new Uint8Array(45)]),job={recordingId:'r',segmentIndex:0};
  for(const [meta,body] of [[{recordingId:'r',index:0},bad],[{recordingId:'r',index:0,transcriptionBlob:bad},original]]){
    const store=journal({...meta,pcmBlob:original});
    await assert.rejects(api({}).transcriptionAudio(store,job,body),{code:'audio_integrity',retryable:false});
    assert.equal(store.meta.pcmBlob,original);
  }
});
test('cancellation and persistence failure cannot silently create a new upload body',async()=>{
  const original=wav(1),store=journal({recordingId:'r',index:0}),job={recordingId:'r',segmentIndex:0};
  const controller=new AbortController();controller.abort();
  await assert.rejects(api({}).transcriptionAudio(store,job,original,controller.signal),{name:'AbortError'});
  assert.equal(store.meta.transcriptionBlob,undefined);
  store.atomic=async()=>{throw Error('Disk full')};
  await assert.rejects(api({}).transcriptionAudio(store,job,original),/Disk full/);
  assert.equal(store.meta.transcriptionBlob,undefined);
});
