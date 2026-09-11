import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Firestore } from '@google-cloud/firestore';
import { Storage, type Bucket } from '@google-cloud/storage';
import { config } from '../src/config.js';
import { generateDek, sealBytes, sealJson, sealText } from '../src/crypto/envelope.js';
import { keyring } from '../src/crypto/keyring.js';
import { createApp } from '../src/http/app.js';
import { issueTokens } from '../src/http/auth.js';
import { makePcm16Wav } from '../src/speaker/audio.js';
import { setFirestoreForTest } from '../src/store/firestore.js';
import type { UserDoc, TranscriptWord } from '../src/store/types.js';

test('authenticated enrollment enforces consent, source quality, revision and account isolation',async t=>{
  const dek=generateDek(),docs=new Map<string,Record<string,unknown>>(),recordPath='users/u/recordings/r',voicePath='users/u/voiceProfiles/known';
  const snapshot=(path:string)=>({exists:docs.has(path),data:()=>docs.get(path)});
  const ref=(path:string):any=>({path,collection:(id:string)=>ref(path+'/'+id),doc:(id:string)=>ref(path+'/'+id),get:async()=>snapshot(path),orderBy:()=>({get:async()=>({docs:[...docs.keys()].filter(key=>key.startsWith(path+'/')).map(snapshot)})})});
  setFirestoreForTest({collection:(name:string)=>ref(name),runTransaction:async(fn:any)=>fn({get:async(r:any)=>snapshot(r.path),set:(r:any,value:any)=>docs.set(r.path,value),update:(r:any,value:any)=>docs.set(r.path,{...docs.get(r.path),...value}),delete:(r:any)=>docs.delete(r.path)})} as unknown as Firestore);
  t.mock.method(keyring,'unwrap',async()=>dek);
  const segmentScope='recording/r/segment/0',bound=(field:string)=>({uid:'u',scope:segmentScope,field});
  const names=sealJson(dek,{'S1.1':'Asha'},{uid:'u',scope:'recording/r',field:'speaker-names'});
  const record={recordingId:'r',state:'ready',updatedAt:'v1',segmentCount:1,sealedSpeakerNames:names};docs.set(recordPath,record);
  const words:TranscriptWord[]='Here are the six clear words'.split(' ').map((text,i)=>({text,speaker:'spk_1',start_ms:i*1000,end_ms:(i+1)*1000}));
  const segmentPath=recordPath+'/segments/0',segment={index:0,startMs:0,storagePath:'fixture-audio',sealedTranscript:sealText(dek,'[00:00] S?: Here are the six clear words',bound('transcript')),sealedWords:sealJson(dek,words,bound('words')),sealedSpeakerMap:sealJson(dek,{'spk_1':'S1.1'},bound('speaker-map'))};docs.set(segmentPath,segment);
  const audio=makePcm16Wav(Buffer.alloc(6*32000)),sealedAudio=sealBytes(dek,audio,bound('audio'));
  t.mock.method(Storage.prototype,'bucket',()=>({file:(path:string)=>{assert.equal(path,'fixture-audio');return{exists:async()=>[true],download:async()=>[Buffer.from(JSON.stringify(sealedAudio))]}}}) as unknown as Bucket);
  const originalSpeaker={...config.speaker},originalFetch=fetch;let embeddings=0,editDuringEmbed=false;
  Object.assign(config.speaker,{serviceUrl:'http://speaker.test',authMode:'none'});
  globalThis.fetch=async(input,init)=>{
    if(String(input)==='http://speaker.test/embed'){
      embeddings++;assert(Buffer.isBuffer(init?.body));
      if(editDuringEmbed)docs.set(recordPath,{...record,updatedAt:'v2'});
      return new Response(JSON.stringify({embedding:Array.from({length:32},(_,i)=>i===0?1:0),model:'fixture-model',duration_ms:6000}));
    }
    assert(String(input).startsWith(origin+'/'),'test must not call a real cloud service');return originalFetch(input,init);
  };
  const server=http.createServer(createApp());await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const tokens:Record<string,string>={};
  for(const uid of ['u','other']){const user={uid,tokenGeneration:1} as UserDoc;docs.set('users/'+uid,user as unknown as Record<string,unknown>);tokens[uid]=(await issueTokens(user)).access_token;}
  const request=async(path:string,method='GET',body?:object,uid='u')=>{
    const response=await fetch(origin+'/v1'+path,{method,headers:{Authorization:'Bearer '+tokens[uid],'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return{status:response.status,data:await response.json() as any};
  };
  const enroll=(body:object)=>request('/recordings/r/remember-speaker','POST',body);
  const good={label:'S1.1',revision:'v1',consent:true};
  try{
    docs.set(recordPath,{...record,sealedSpeakerNames:null,sealedIdentifiedSpeakers:sealJson(dek,{'S1.1':'Asha'},{uid:'u',scope:'recording/r',field:'identified-speakers'}),sealedTranscript:sealText(dek,'[00:00] S1.1: Here are the six clear words',{uid:'u',scope:'recording/r',field:'transcript'}),sealedMemory:sealJson(dek,{title:'Fixture',executive_summary:'Six words',conversations:[]},{uid:'u',scope:'recording/r',field:'memory'})});
    assert.equal((await request('/recordings/r/speakers')).data.names_confirmed,false);
    const confirmation=await request('/recordings/r/speakers','POST',{speaker_names:{'S1.1':'Asha'},revision:'v1'});
    assert.equal(confirmation.status,200);assert.equal(confirmation.data.names_confirmed,true);assert(docs.get(recordPath)?.sealedSpeakerNames,'accepting an unchanged automatic suggestion establishes an explicit override');assert.equal(embeddings,0);
    docs.set(recordPath,record);
    assert.equal((await enroll({...good,consent:false})).data.error.code,'consent_required');assert.equal(embeddings,0);
    docs.set(recordPath,{...record,sealedSpeakerNames:null});assert.equal((await enroll(good)).data.error.code,'name_required');docs.set(recordPath,record);
    assert.equal((await enroll({...good,revision:'stale'})).status,409);
    docs.set(segmentPath,{...segment,sealedWords:sealJson(dek,words.slice(0,2),bound('words'))});assert.equal((await enroll(good)).data.error.code,'no_sample');assert.equal(embeddings,0);
    docs.set(segmentPath,segment);
    const remembered=await enroll(good);assert.equal(remembered.status,200);assert.equal(remembered.data.speaker.name,'Asha');assert(!Object.hasOwn(remembered.data.speaker,'embedding'));assert.equal(embeddings,1);
    assert(!JSON.stringify(docs.get(voicePath)).includes('Asha'));assert.deepEqual(docs.get(segmentPath),segment,'source audio and word envelopes are unchanged');
    const id=remembered.data.speaker.id;assert.equal((await request('/known-speakers')).data.speakers.length,1);
    assert.deepEqual((await request('/known-speakers','GET',undefined,'other')).data.speakers,[]);
    await request('/known-speakers/'+id,'DELETE',undefined,'other');assert(docs.has(voicePath),'another account cannot delete this voice');
    editDuringEmbed=true;assert.equal((await enroll(good)).status,409);assert.equal((await request('/known-speakers')).data.speakers.length,1,'a changed source cannot overwrite enrollment');
    assert.equal((await request('/known-speakers/not-an-id','DELETE')).status,400);
    assert.equal((await request('/known-speakers/'+id,'DELETE')).status,200);assert.equal(docs.has(voicePath),false);
  }finally{
    globalThis.fetch=originalFetch;Object.assign(config.speaker,originalSpeaker);setFirestoreForTest(null);await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
