import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import { Storage, type Bucket } from '@google-cloud/storage';
import { generateDek, sealBytes, sealJson, sealText } from '../src/crypto/envelope.js';
import { keyring } from '../src/crypto/keyring.js';
import { createApp } from '../src/http/app.js';
import { issueTokens } from '../src/http/auth.js';
import { makePcm16Wav } from '../src/speaker/audio.js';
import { transcribeUploadedWindow } from '../src/pipeline/rolling-transcription.js';
import * as db from '../src/store/firestore.js';
import type { RecordingDoc, SegmentDoc, UserDoc } from '../src/store/types.js';

// Staged writes verify rollback and the read-before-write SDK contract. Real
// concurrent transactions are separately exercised by the Firestore CI job.
function fixture() {
  const rows = new Map<string, any>();
  const ref = (path: string): any => ({path, collection: (id:string)=>ref(path+'/'+id), doc:(id:string)=>ref(path+'/'+id),
    get:async()=>path.split('/').length%2===0 ? {exists:rows.has(path),data:()=>structuredClone(rows.get(path))} : {docs:[...rows].filter(([key])=>key.startsWith(path+'/')&&key.split('/').length===path.split('/').length+1).map(([,value])=>({data:()=>structuredClone(value)}))},
    update:async(fields:any)=>{if(!rows.has(path))throw Object.assign(Error('Missing'),{code:5});rows.set(path,{...rows.get(path),...fields});}});
  let failCommit=false;
  db.setFirestoreForTest({collection:(path:string)=>ref(path),runTransaction:async(fn:any)=>{
    const writes:(()=>void)[]=[];
    const result=await fn({get:(r:any)=>{assert.equal(writes.length,0);return r.get();},
      create:(r:any,doc:any)=>writes.push(()=>{assert(!rows.has(r.path));rows.set(r.path,structuredClone(doc));}),
      update:(r:any,fields:any)=>writes.push(()=>{assert(rows.has(r.path));rows.set(r.path,{...rows.get(r.path),...structuredClone(fields)});})});
    if(failCommit)throw Error('Commit unavailable');
    for(const write of writes)write();return result;
  }} as unknown as Firestore);
  const recording={recordingId:'r',state:'created',createdAt:'first',endedAt:null,uploadedSegments:0,language:'auto'} as RecordingDoc;
  const parent='users/u/recordings/r',child=parent+'/segments/0';rows.set(parent,recording);
  const source={index:0,startMs:0,endMs:1000,sha256:'digest',bytes:32044,storagePath:'attempt-one',state:'accepted',sealedTranscript:null,sealedWords:null,language:null,uploadedAt:'now',transcribedAt:null} as SegmentDoc;
  return{rows,parent,child,recording,source,fail:()=>{failCommit=true;}};
}

test('segment commits preserve accepted sources, completed results and parent state',async t=>{
  const f=fixture();t.after(()=>db.setFirestoreForTest(null));
  await db.acceptSegment('u','r',f.source,'first');
  assert.equal(f.rows.get(f.parent).uploadedSegments,1);
  const dek=generateDek(),bind=(field:string)=>({uid:'u',scope:'recording/r/segment/0',field});
  const complete={...f.source,state:'transcribed',sealedTranscript:sealText(dek,'first result',bind('transcript')),sealedWords:sealJson(dek,[],bind('words')),transcribedAt:'done',transcriptionAudioPolicy:'stored-upload-v1',transcriptionReview:{attempted:false,annotationsComplete:true}} as SegmentDoc;
  await db.completeSegmentTranscription('u','r',complete);
  f.rows.set(f.parent,{...f.rows.get(f.parent),state:'ready',endedAt:'ended',processingLease:'current'});
  const before=structuredClone(f.rows.get(f.parent));
  const duplicate=await db.acceptSegment('u','r',{...f.source,storagePath:'retry-object'},'first');
  assert.deepEqual(duplicate,complete);assert.deepEqual(f.rows.get(f.parent),before);
  assert.deepEqual((await db.createRecording('u',{...f.recording,state:'created'})).doc,before,'create retries cannot regress an existing recording');
  const late=await db.completeSegmentTranscription('u','r',{...complete,sealedTranscript:sealText(dek,'late',bind('transcript'))});
  assert.deepEqual(late,complete,'first complete result wins');
  for(const change of [{sha256:'changed'},{endMs:2000},{bytes:12},{index:1}])await assert.rejects(db.acceptSegment('u','r',{...f.source,...change},'first'),{status:409});
  await assert.rejects(db.acceptSegment('u','r',f.source,'different-creation'),{status:409});
  await assert.rejects(db.completeSegmentTranscription('u','r',{...complete,storagePath:'other-object'}),{status:409});
  await assert.rejects(db.saveSegmentSpeakerMap('u','r',complete,'old',null),{status:409});
  await db.saveSegmentSpeakerMap('u','r',complete,'current',sealJson(dek,{},bind('speaker-map')));
  assert.deepEqual(f.rows.get(f.child).sealedTranscript,complete.sealedTranscript);
  await db.beginRecordingDeletion('u','r');
  await assert.rejects(db.acceptSegment('u','r',f.source,'first'),{status:404});
  await assert.rejects(db.completeSegmentTranscription('u','r',complete),{status:404});
  await assert.rejects(db.createRecording('u',f.recording),{status:404});
  f.rows.delete(f.parent);f.rows.delete(f.child);
  await assert.rejects(db.completeSegmentTranscription('u','r',complete),{status:404});assert.equal(f.rows.has(f.child),false);
});

test('a rejected acceptance transaction leaves both the counter and segment unchanged',async t=>{
  const f=fixture();t.after(()=>db.setFirestoreForTest(null));f.fail();
  await assert.rejects(db.acceptSegment('u','r',f.source,'first'),/Commit unavailable/);
  assert.equal(f.rows.has(f.child),false);assert.equal(f.rows.get(f.parent).uploadedSegments,0);
});

test('a reviewed retry replaces only the exact legacy empty result; concurrent completions keep the winner', async t => {
  const f = fixture(), dek = generateDek();
  t.after(() => db.setFirestoreForTest(null));
  const bind = (field: string) => ({ uid: 'u', scope: 'recording/r/segment/0', field });
  await db.acceptSegment('u', 'r', f.source, 'first');
  const legacy = await db.completeSegmentTranscription('u', 'r', { ...f.source, state: 'transcribed',
    sealedTranscript: sealText(dek, '', bind('transcript')), sealedWords: sealJson(dek, [], bind('words')) });
  const recovered = { ...legacy, sealedTranscript: sealText(dek, 'Recovered complete speech', bind('transcript')),
    transcriptionReview: { attempted: true, annotationsComplete: false, policy: 'text-first-v1' as const, outcome: 'speech' as const } };
  assert.deepEqual(await db.completeSegmentTranscription('u', 'r', recovered), legacy, 'replacement requires the original empty envelope');
  const winner = await db.completeSegmentTranscription('u', 'r', recovered, legacy.sealedTranscript);
  assert.deepEqual(winner.sealedTranscript, recovered.sealedTranscript);
  const late = { ...recovered, sealedTranscript: sealText(dek, 'Late duplicate', bind('transcript')) };
  assert.deepEqual(await db.completeSegmentTranscription('u', 'r', late, legacy.sealedTranscript), winner);
});

test('finalization checks complete segments atomically and preserves later processing on retries',async t=>{
  const f=fixture();t.after(()=>db.setFirestoreForTest(null));
  const fields={endedAt:'ended',durationMs:1000,segmentCount:1};
  await assert.rejects(db.finalizeRecording('u','r',fields),{status:409,retryable:true});
  assert.equal(f.rows.get(f.parent).state,'created');
  await db.acceptSegment('u','r',f.source,'first');
  assert.equal((await db.finalizeRecording('u','r',fields)).state,'uploaded');
  for(const state of ['transcribing','understanding','indexing','ready']){
    f.rows.set(f.parent,{...f.rows.get(f.parent),state,processingLease:'current',progress:.8});
    const before=structuredClone(f.rows.get(f.parent));
    assert.deepEqual(await db.finalizeRecording('u','r',fields),before);
    assert.deepEqual(f.rows.get(f.parent),before);
    await assert.rejects(db.finalizeRecording('u','r',{...fields,durationMs:2000}),{status:409,retryable:false});
  }
  await db.beginRecordingDeletion('u','r');await assert.rejects(db.finalizeRecording('u','r',fields),{status:404});
});

test('authenticated PUT preserves permanent model failures, source bytes and deletion fencing',async t=>{
  const f=fixture(),dek=generateDek(),objects=new Map<string,Buffer>();
  t.mock.method(keyring,'unwrap',async()=>dek);
  t.mock.method(OAuth2Client.prototype,'verifyIdToken',async()=>({getPayload:()=>({email:'fixture'})}) as any);
  t.mock.method(Storage.prototype,'bucket',()=>({file:(path:string)=>({
    save:async(bytes:Buffer)=>{assert(!objects.has(path),'upload attempts never overwrite a blob');objects.set(path,bytes);},
    exists:async()=>[objects.has(path)],download:async()=>[objects.get(path)],delete:async()=>objects.delete(path)
  })}) as unknown as Bucket);
  const user={uid:'u',tokenGeneration:1} as UserDoc;f.rows.set('users/u',user);
  const token=(await issueTokens(user)).access_token;
  const server=http.createServer(createApp());await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const original=fetch;let modelCalls=0,removeDuringModel=false;
  globalThis.fetch=async(input,init)=>{
    if(String(input).startsWith(origin))return original(input,init);
    assert(String(input).endsWith('/interactions'),'no real cloud calls');modelCalls++;
    assert.deepEqual(Buffer.from(JSON.parse(String(init?.body)).input[0].data,'base64'),audio,'encrypted storage round-trip must preserve the uploaded WAV exactly');
    if(removeDuringModel){
      await db.beginRecordingDeletion('u','r');f.rows.delete(f.parent);f.rows.delete(f.child);
      return new Response(JSON.stringify({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'Hello',annotations:[{type:'word_info',text:'Hello',speaker:'spk_1',start_offset:'0s',end_offset:'1s'}]}]}]}));
    }
    return new Response(JSON.stringify({error:{message:'Request contains an invalid argument. PRIVATE DETAIL',code:'invalid_request'}}),{status:400});
  };
  t.after(async()=>{globalThis.fetch=original;db.setFirestoreForTest(null);await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const audio=makePcm16Wav(Buffer.alloc(32000,16));
  const put=async(bytes=audio,extra:Record<string,string>={})=>{
    const res=await fetch(origin+'/v1/recordings/r/segments/0',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'audio/wav','X-Synap-Start-Ms':'0','X-Synap-End-Ms':'1000',...extra},body:bytes});
    return {status:res.status,data:await res.json() as any};
  };
  const malformed=Buffer.concat([audio.subarray(0,44),Buffer.alloc(1),audio.subarray(44)]);
  malformed.writeUInt32LE(malformed.length-8,4);malformed.writeUInt32LE(malformed.length-44,40);
  for(const broken of [malformed,audio.subarray(0,audio.length-1)]){
    const result=await put(broken);
    assert.equal(result.status,400);assert.equal(result.data.error.code,'invalid_audio');
    assert.equal(result.data.error.retryable,false);assert.equal(modelCalls,0);
    assert.equal(objects.size,0);assert.equal(f.rows.has(f.child),false,'invalid audio cannot become accepted evidence');
  }
  for(let attempt=0;attempt<2;attempt++){
    const result=await put();assert.equal(result.status,502);assert.equal(result.data.error.retryable,false);assert(!JSON.stringify(result.data).includes('PRIVATE DETAIL'));
    assert.equal(objects.size,1);assert.equal(f.rows.get(f.parent).uploadedSegments,1);assert.equal(f.rows.get(f.child).state,'accepted');
  }
  assert(modelCalls>0);const before=modelCalls,path=f.rows.get(f.child).storagePath,bytes=Buffer.from(objects.get(path)!);
  // A source accepted by an older release also must not reach the model again.
  const invalidStored=Buffer.from(JSON.stringify(sealBytes(dek,malformed,{uid:'u',scope:'recording/r/segment/0',field:'audio'})));
  objects.set(path,invalidStored);
  await assert.rejects(transcribeUploadedWindow('u','r',0,dek),{status:409,retryable:false});
  assert.equal(modelCalls,before);assert.deepEqual(objects.get(path),invalidStored);
  objects.set(path,bytes);
  const conflict=await put(makePcm16Wav(Buffer.alloc(32000,17)));assert.equal(conflict.status,409);assert.equal(conflict.data.error.retryable,false);
  assert.equal((await put(audio,{'X-Synap-End-Ms':'2000'})).status,409);
  assert.equal((await put(audio,{'X-Synap-End-Ms':'NaN'})).status,400);
  assert.equal(modelCalls,before);assert.deepEqual(objects.get(path),bytes);
  removeDuringModel=true;const late=await put();assert.equal(late.status,404);assert.equal(late.data.error.retryable,false);
  assert.equal(f.rows.has(f.child),false,'model completion cannot recreate a deleted child');
  const task=async()=>{
    const result=await fetch(origin+'/v1/tasks/process',{method:'POST',headers:{Authorization:'Bearer fixture-task','Content-Type':'application/json'},body:JSON.stringify({uid:'u',recordingId:'r'})});
    return {status:result.status,data:await result.json() as any};
  };
  const removed=await task();assert.equal(removed.status,200);assert.equal(removed.data.error.retryable,false);
  f.rows.set(f.parent,{...f.recording,state:'failed',retryable:false});
  const beforeRedelivery=modelCalls;const permanent=await task();assert.equal(permanent.status,200);assert.equal(modelCalls,beforeRedelivery,'redelivery does not retry a permanent model failure');
  // Missing source while the parent is still mutable has no durable failure:
  // retain the delivery instead of acknowledging a failed checkpoint write.
  f.rows.set(f.parent,{...f.recording,state:'created'});
  const pending=await task();assert.equal(pending.status,500);assert.equal(pending.data.error.retryable,true);

});
