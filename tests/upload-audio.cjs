'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function api(enhancement){
  const context={Blob,DOMException,console,setTimeout,clearTimeout,URL,AbortController,SynapAudioEnhancement:enhancement};
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
  const original=new Blob(['source']),processed=new Blob(['processed']);
  const journalStore=journal({recordingId:'r',index:0,pcmBlob:original,notes:'preserved'});
  let calls=0;const job={recordingId:'r',segmentIndex:0};
  const first=await api({prepareForUpload:async()=>{calls++;return processed}}).transcriptionAudio(journalStore,job,original);
  assert.equal(first,processed);assert.equal(journalStore.meta.pcmBlob,original);
  const retry=await api({prepareForUpload:async()=>{throw new Error('must reuse persisted bytes')}}).transcriptionAudio(journalStore,job,original);
  assert.equal(await retry.text(),'processed');assert.equal(calls,1);assert.equal(journalStore.meta.notes,'preserved');
});
test('an original-audio fallback also stays identical on the next attempt',async()=>{
  const original=new Blob(['original']),journalStore=journal({recordingId:'r',index:1});
  const job={recordingId:'r',segmentIndex:1};
  await api({prepareForUpload:async()=>original}).transcriptionAudio(journalStore,job,original);
  const retry=await api({prepareForUpload:async()=>new Blob(['new model'])}).transcriptionAudio(journalStore,job,original);
  assert.equal(retry,original);
});
