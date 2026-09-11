import assert from 'node:assert/strict';
import test from 'node:test';
import { transcribeSegment,annotationsComplete,toSpeakerLines } from '../src/gemini/transcribe.js';

const reply=(text:string,parts:string[])=>new Response(JSON.stringify({status:'completed',steps:[{type:'model_output',content:[{type:'text',text,annotations:parts.map((word,i)=>({type:'word_info',text:word,speaker:'spk_1',start_offset:`${i}s`,end_offset:`${i+1}s`}))}]}]}));
test('complete diarization does not add another model call',async()=>{
  const original=fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return reply('Hello there',['Hello','there'])};
  try{const result=await transcribeSegment(Buffer.from('fixture'),'audio/wav');assert.equal(calls,1);assert.equal(result.review.attempted,false);assert.equal(result.review.annotationsComplete,true)}finally{globalThis.fetch=original}
});
test('one review repairs incomplete annotations while preserving recognized words and offsets',async()=>{
  const original=fetch;let calls=0;
  globalThis.fetch=async()=>++calls===1?reply('Hello there',['Hello']):reply('Hello there',['Hello','there']);
  try{const result=await transcribeSegment(Buffer.from('fixture'),'audio/wav',{baseOffsetMs:30000});assert.equal(calls,2);assert.equal(result.review.annotationsComplete,true);assert.equal(result.words[0]?.start_ms,30000);assert.equal(result.text,'[00:30] S?: Hello there')}finally{globalThis.fetch=original}
});
test('a disagreeing or failed review cannot rewrite or discard the first transcript',async()=>{
  for(const fail of [false,true]){
    const original=fetch;let calls=0;
    globalThis.fetch=async()=>{if(++calls===1)return reply('Do not ship',['Do']);if(fail)throw new Error('offline');return reply('Ship now',['Ship','now'])};
    try{const result=await transcribeSegment(Buffer.from('fixture'),'audio/wav');assert.equal(result.text,'[00:00] S?: Do not ship');assert.equal(result.review.annotationsComplete,false)}finally{globalThis.fetch=original}
  }
});
test('invalid timing never turns an untimed response into false 0 ms speaker turns',()=>{
  const words=[{text:'Hello',speaker:'S1',start_ms:0,end_ms:0}];
  assert.equal(annotationsComplete('Hello',words),false);
  assert.equal(toSpeakerLines(words,'[00:30] S?: Hello'),'[00:30] S?: Hello');
});
test('speaker formatting cannot lose meaningful numeric punctuation or symbols',()=>{
  for(const [flat,annotated] of [['-5','5'],['$5','5'],['5%','5'],['5.5','55'],['1/2','12'],['12:30','1230'],['.5','5']]){
    const words=[{text:annotated!,speaker:'S1',start_ms:0,end_ms:1000}],source='[00:30] S?: '+flat;
    assert.equal(annotationsComplete(source,words),false);assert.equal(toSpeakerLines(words,source),source);
  }
});
test('annotation review never changes signs, currencies, percentages, or original text casing',async()=>{
  for(const [source,candidate,accept] of [['Cost is -5','Cost is 5',false],['Cost is $5','Cost is 5',false],['Cost is 5%','Cost is 5',false],['Hello there','hello there',true]] as const){
    const original=fetch;let calls=0;
    globalThis.fetch=async()=>++calls===1?reply(source,[source.split(' ')[0]!]):reply(candidate,candidate.split(' '));
    try{
      const result=await transcribeSegment(Buffer.from('fixture'),'audio/wav');
      assert.equal(result.text,'[00:00] S?: '+source);assert.equal(result.review.annotationsComplete,accept);
    }finally{globalThis.fetch=original}
  }
});
test('cancellation before a model call or during retry prevents later requests',async()=>{
  for(const abortFirst of [true,false]){
    const original=fetch,controller=new AbortController();let calls=0;
    if(abortFirst)controller.abort();
    globalThis.fetch=async()=>{calls++;controller.abort();return new Response('{}',{status:503})};
    try{
      await assert.rejects(transcribeSegment(Buffer.from('fixture'),'audio/wav',{signal:controller.signal}),{name:'AbortError'});
      assert.equal(calls,abortFirst?0:1);
    }finally{globalThis.fetch=original}
  }
});
