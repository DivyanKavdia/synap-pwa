import assert from 'node:assert/strict';
import test from 'node:test';
import {speechWindow} from '../src/gemini/speech-window.js';
import {makePcm16Wav} from '../src/speaker/audio.js';
import {extractMemory,validateMemory} from '../src/gemini/memory.js';
import {addConfirmedSample,identifyKnownSpeakers,type KnownSpeaker} from '../src/speaker/known.js';
import {prepareMeeting} from '../src/pipeline/meeting-preparation.js';
import {generateDek,sealJson} from '../src/crypto/envelope.js';
import {binding} from '../src/pipeline/process.js';
import type {StructuredMemory,ConversationDoc,FollowUpDoc} from '../src/store/types.js';

test('speech windows skip digital silence, preserve quiet words, and keep a half-second lead-in',()=>{
  assert(speechWindow(makePcm16Wav(Buffer.alloc(160000))).silent);
  const pcm=Buffer.alloc(160000);for(let i=32000;i<48000;i++)pcm.writeInt16LE(i%2?3:-3,i*2);
  const original=makePcm16Wav(pcm),result=speechWindow(original);
  assert.equal(result.silent,false);assert.equal(result.offsetMs,1500);assert.equal(result.audio.length,64044);
  assert.equal(original.length,160044);assert(result.audio.includes(pcm.subarray(64000,96000)));
  assert.deepEqual(speechWindow(Buffer.from('unsupported')),{audio:Buffer.from('unsupported'),offsetMs:0,silent:false});
});
test('meeting details reject ungrounded reminders and invalid dates/spans, while retaining real topic chapters',()=>{
  const memory:StructuredMemory={schema_version:2,title:'Plan',executive_summary:'Plan',key_points:[],people:[],topics:[],conversations:[{title:'Plan',summary:'Plan',start_ms:0,end_ms:20000,people:[],topics:[],decisions:[],follow_ups:[],chapters:[{title:'Budget',summary:'Costs',start_ms:0,end_ms:10000},{title:'Overlapping',summary:'',start_ms:9000,end_ms:12000},{title:'Delivery',summary:'Dates',start_ms:15000,end_ms:20000}],unresolved_questions:[{text:'Who approves?',start_ms:19000,end_ms:20000}],action_items:[{task:'Send invoice',owner:'self',kind:'reminder',evidence:'remind me tomorrow to send the invoice',due_date:'2026-09-13',start_ms:1000,end_ms:2000},{task:'Invented',owner:'self',kind:'reminder',evidence:'pay someone',due_date:null,start_ms:5000,end_ms:6000},{task:'Invalid date',owner:'self',due_date:'2026-02-30',start_ms:5000,end_ms:6000}]}]};
  const result=validateMemory(memory,20000,'[0:01] YOU: remind me tomorrow to send the invoice');
  assert.equal(result.conversations[0]?.action_items.length,1);assert.equal(result.conversations[0]?.chapters?.length,2);assert.equal(result.conversations[0]?.unresolved_questions?.[0]?.text,'Who approves?');
});
test('confirmed voice samples stay bounded, cannot silently merge different people, and remain conservative',()=>{
  const first:KnownSpeaker={id:'first',name:'Asha',embedding:[1,0],model:'m',duration_ms:6000,consentVersion:1,createdAt:'today'};
  const next={...first,id:'next',embedding:[.98,.2]};
  const updated=addConfirmedSample(first,next);assert.equal(updated.references?.length,2);assert.deepEqual(addConfirmedSample(updated,next),updated);
  assert.throws(()=>addConfirmedSample(first,{...next,embedding:[0,1]}),/differs/);
  assert.throws(()=>addConfirmedSample(first,{...next,name:'Someone else'}),/name/);
  assert.throws(()=>addConfirmedSample(first,{...next,model:'new'}),/model/);
  assert.equal(identifyKnownSpeakers(new Map([['S1',{embedding:[1,0],model:'m',duration_ms:6000}]]),[updated]).S1,'Asha');
});
test('preparation excludes unrelated people and completed actions and keeps timestamp sources',()=>{
  const dek=generateDek(),uid='u';
  const conversation=(id:string,personId:string):ConversationDoc=>({conversationId:id,recordingId:id,day:'2026-09-12',startMs:1000,endMs:9000,startedAt:'2026-09-12T00:00:00Z',sealedContent:sealJson(dek,{title:id,summary:'Recap',unresolvedQuestions:[{text:'Budget?',start_ms:2000}]},binding(uid,`conversation/${id}`,'content')),embedding:null,personIds:[personId],topicKeys:[],highlightCount:0,createdAt:'now'});
  const follow=(id:string,state:'open'|'done'):FollowUpDoc=>({followUpId:id,recordingId:'r',conversationId:'r',startMs:3000,ownerType:'self',counterpartyPersonId:null,state,dueDate:null,createdAt:'now',updatedAt:'now',sealedTask:sealJson(dek,{task:id,owner:'self'},binding(uid,`followUp/${id}`,'task'))});
  const result=prepareMeeting(uid,dek,'asha',[conversation('r','asha'),conversation('other','blair')],[follow('open','open'),follow('closed','done')]);
  assert.equal(result.history.length,1);assert.deepEqual(result.history[0]?.questions[0]?.source,{recording_id:'r',start_ms:2000});assert.equal(result.open_actions.length,1);assert.equal(result.open_actions[0]?.text,'open');
});

test('person preparation falls back safely when the optional index is not available',async()=>{
  const {setFirestoreForTest,conversationsForPerson}=await import('../src/store/firestore.js');
  const queries:string[]=[];
  const ref=(path:string,filtered=false):any=>({collection:(name:string)=>ref(path+'/'+name),doc:(id:string)=>ref(path+'/'+id),where:()=>ref(path,true),orderBy:()=>ref(path,filtered),limit:()=>ref(path,filtered),get:async()=>{
    queries.push(path);if(filtered)throw Object.assign(new Error('index not ready'),{code:9});
    return {docs:[{data:()=>({personIds:['asha'],recordingId:'correct',embedding:null})},{data:()=>({personIds:['other'],recordingId:'unrelated',embedding:null})}]};
  }});
  setFirestoreForTest({collection:(name:string)=>ref(name)} as any);
  try{const records=await conversationsForPerson('u','asha');assert.equal(records.length,1);assert.equal(records[0]?.recordingId,'correct');assert.deepEqual(queries,['users/u/conversations','users/u/conversations']);}finally{setFirestoreForTest(null)}
});

test("empty speech does not create a paid or invented meeting summary",async()=>{
  const result=await extractMemory({transcript:"",durationMs:30000,highlightOffsetsMs:[],knownPeople:["Asha"],language:"auto"});
  assert.deepEqual(result.conversations,[]);assert.deepEqual(result.people,[]);assert.equal(result.executive_summary,"");
});
