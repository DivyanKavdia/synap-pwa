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
test('preprocessing persists exact upload bytes across retry/reload without modifying source PCM',async()=>{
  const original=wav(1),processed=wav(2);
  const journalStore=journal({recordingId:'r',index:0,pcmBlob:original,notes:'preserved'});
  let calls=0;const job={recordingId:'r',segmentIndex:0};
  const first=await api({prepareForUpload:async()=>{calls++;return processed}}).transcriptionAudio(journalStore,job,original);
  assert.equal(first,processed);assert.equal(journalStore.meta.pcmBlob,original);
  const retry=await api({prepareForUpload:async()=>{throw new Error('must reuse persisted bytes')}}).transcriptionAudio(journalStore,job,original);
  assert.deepEqual(await retry.arrayBuffer(),await processed.arrayBuffer());assert.equal(calls,1);assert.equal(journalStore.meta.notes,'preserved');
});
test('an original-audio fallback also stays identical on the next attempt',async()=>{
  const original=wav(1),journalStore=journal({recordingId:'r',index:1});
  const job={recordingId:'r',segmentIndex:1};
  await api({prepareForUpload:async()=>original}).transcriptionAudio(journalStore,job,original);
  const retry=await api({prepareForUpload:async()=>wav(2)}).transcriptionAudio(journalStore,job,original);
  assert.equal(retry,original);
});

test('invalid source, cached and model WAVs never become transcription uploads',async()=>{
  const original=wav(1),bad=new Blob([new Uint8Array(45)]),job={recordingId:'r',segmentIndex:0};
  let modelCalls=0;
  const client=api({prepareForUpload:async()=>{modelCalls++;return bad;}});
  for(const meta of [{recordingId:'r',index:0},{recordingId:'r',index:0,transcriptionBlob:bad}]) {
    const store=journal(meta);
    await assert.rejects(client.transcriptionAudio(store,job,bad),{code:'audio_integrity',retryable:false});
    assert.equal(modelCalls,0);
  }
  const store=journal({recordingId:'r',index:0,pcmBlob:original});
  await assert.rejects(client.transcriptionAudio(store,job,original),{code:'audio_integrity'});
  assert.equal(modelCalls,1);assert.equal(store.meta.pcmBlob,original);
  assert.equal(store.meta.transcriptionBlob,undefined,'malformed model output is not cached');
});
