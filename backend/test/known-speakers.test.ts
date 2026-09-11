import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore } from '@google-cloud/firestore';
import { generateDek } from '../src/crypto/envelope.js';
import { setFirestoreForTest } from '../src/store/firestore.js';
import { identifyKnownSpeakers,mergeSpeakerIdentifications,updateDirectory,readKnownSpeakers,saveKnownSpeaker,forgetKnownSpeaker,speakerViews,type KnownSpeaker } from '../src/speaker/known.js';
import type { SpeakerEmbeddingResult } from '../src/speaker/client.js';

const voice=(embedding:number[],model='m'):SpeakerEmbeddingResult=>({embedding,model,duration_ms:6000});
const person=(id:string,name:string,embedding:number[]):KnownSpeaker=>({...voice(embedding),id,name,consentVersion:1,createdAt:'today'});
test('saved names require a strong, unambiguous acoustic match in both directions',()=>{
  const people=[person('a','Asha',[1,0]),person('b','Blair',[0,1])];
  assert.deepEqual({...identifyKnownSpeakers(new Map([['S1',voice([1,0])],['S2',voice([0,1])]]),people)},{S1:'Asha',S2:'Blair'});
  assert.deepEqual({...identifyKnownSpeakers(new Map([['S1',voice([.7,.7])]]),people)},{});
  assert.deepEqual({...identifyKnownSpeakers(new Map([['S1',voice([1,0])],['S2',voice([.99,.01])]]),people)},{});
  assert.deepEqual({...identifyKnownSpeakers(new Map([['S1',voice([1,0],'other-model')]]),people)},{});
  assert.deepEqual({...identifyKnownSpeakers(new Map([['S1',voice([0,0])]]),people)},{});
  assert.deepEqual({...identifyKnownSpeakers(new Map([['YOU',voice([1,0])],['S2',voice([.9,.1])]]),[people[0]!])},{},'the wearer competes with other voices, even when already self-labeled');
});
test('cross-window name conflicts and unmatched evidence remain anonymous',()=>{
  for(const second of [{spk_2:'Blair'},{}] as Record<string,string>[]){
    const names:Record<string,string>={},conflicts=new Set<string>();
    mergeSpeakerIdentifications({spk_1:'S1.1'},['spk_1'],{spk_1:'Asha'},names,conflicts);assert.deepEqual(names,{'S1.1':'Asha'});
    mergeSpeakerIdentifications({spk_2:'S1.1'},['spk_2'],second,names,conflicts);assert.deepEqual(names,{});
    mergeSpeakerIdentifications({spk_3:'S1.1'},['spk_3'],{spk_3:'Asha'},names,conflicts);assert.deepEqual(names,{},'later matches cannot erase conflicting evidence');
  }
});
test('same-name enrollment does not silently merge people and the directory is bounded',()=>{
  const existing=person('a','Asha',[1,0]);
  assert.throws(()=>updateDirectory([existing],person('b','asha',[0,1])),/distinct name/);
  assert.equal(updateDirectory([existing],{...existing,name:'Asha Rao'}).length,1);
  const full=Array.from({length:20},(_,i)=>person(String(i),'Person '+i,[1,0]));
  assert.throws(()=>updateDirectory(full,person('extra','Extra',[1,0])),/20 voices/);
  assert.equal('embedding' in speakerViews([existing])[0]!,false);
});
test('voice enrollment is encrypted, owner scoped, revision checked, and removable',async()=>{
  const docs=new Map<string,Record<string,unknown>>();
  const ref=(path:string):any=>({path,collection:(id:string)=>ref(path+'/'+id),doc:(id:string)=>ref(path+'/'+id),get:async()=>snapshot(path)});
  const snapshot=(path:string)=>({exists:docs.has(path),data:()=>docs.get(path)});
  const fake={collection:(name:string)=>ref(name),runTransaction:async(fn:any)=>fn({get:async(r:any)=>snapshot(r.path),set:(r:any,data:any)=>docs.set(r.path,data),delete:(r:any)=>docs.delete(r.path)})};
  setFirestoreForTest(fake as unknown as Firestore);
  const dek=generateDek(),recordPath='users/u/recordings/r',directory='users/u/voiceProfiles/known';
  docs.set(recordPath,{state:'ready',updatedAt:'v1'});
  try{
    await saveKnownSpeaker('u',dek,person('a','Asha',[1,0]),'r','v1');
    assert(!JSON.stringify(docs.get(directory)).includes('Asha'));
    assert.equal((await readKnownSpeakers('u',dek))[0]?.name,'Asha');
    assert.deepEqual(await readKnownSpeakers('other',dek),[]);
    docs.set('users/other/voiceProfiles/known',docs.get(directory)!);
    await assert.rejects(readKnownSpeakers('other',dek));
    await assert.rejects(saveKnownSpeaker('u',dek,person('b','Blair',[0,1]),'r','stale'),/changed/);
    assert.equal((await readKnownSpeakers('u',dek)).length,1);
    await forgetKnownSpeaker('u',dek,'a');assert.equal(docs.has(directory),false);
  }finally{setFirestoreForTest(null)}
});
