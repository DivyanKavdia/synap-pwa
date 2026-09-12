'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function load(file){const c={document:{readyState:"loading",addEventListener(){},getElementById(){return null},querySelector(){return null}},Blob,DataView,Uint8Array,DOMException,URL,setTimeout,clearTimeout};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8'),c);return c}
test('short-window speech guard detects a missing syllable even when file length agrees',()=>{
  const api=load('audio-enhancement.js').SynapAudioEnhancement;
  const dry=new DataView(new ArrayBuffer(1324)),wet=new DataView(new ArrayBuffer(1324));
  for(let i=44;i<1324;i+=2){dry.setInt16(i,i%4?1000:-1000,true);wet.setInt16(i,i%4?700:-700,true)}
  assert(api.preservesSpeech(dry,wet));
  for(let i=684;i<1324;i+=2)wet.setInt16(i,0,true);
  assert.equal(api.preservesSpeech(dry,wet),false);assert.equal(api.digitalSilence(dry),false);assert(api.digitalSilence(new DataView(new ArrayBuffer(1324))));
});
test('recording quality flags actual clipping and quiet audio without changing PCM',()=>{
  const api=load('audio-quality.js').SynapAudioQuality;
  const pcm=new Uint8Array(96000),v=new DataView(pcm.buffer);for(let i=0;i<pcm.length;i+=2)v.setInt16(i,32767,true);
  api.observe(pcm);assert(api.describe(api.snapshot()).some(s=>s.includes('clipping')));assert.equal(v.getInt16(0,true),32767);
  api.reset();api.observe(new Uint8Array(96000));assert(api.describe(api.snapshot()).some(s=>s.includes('quiet')));
});
test('meeting preparation matches exact people and includes source offsets across days',()=>{
  const api=load('meeting-tools.js').SynapMeetingTools;
  const record={id:'r',createdAt:'2026-09-12T00:00:00Z',meeting:{conversations:[{title:'Budget',summary:'Discussed',start_ms:2000,people:[{name:'Asha'}],unresolved_questions:[{text:'When?',start_ms:2500}]}]}};
  const data=api.localPreparation('Asha',[record]);assert.equal(data.history[0].source.start_ms,2000);assert.equal(data.history[0].questions[0].source.start_ms,2500);assert.equal(api.localPreparation('Ash',[record]).history.length,0);
});

test('local preparation keeps legacy evidence without claiming old actions are open',()=>{
  const api=load('meeting-tools.js').SynapMeetingTools;
  const data=api.localPreparation(' IRIS ',[{id:'older',createdAt:'invalid',name:'Earlier project',summary:'Saved recap',meeting:{people:[{name:'Iris'}],action_items:[{task:'Review estimate',start_seconds:3},{task:'Already sent',state:'done'}]}}]);
  assert.equal(data.history[0].title,'Earlier project');assert.equal(data.history[0].started_at,'');
  assert.equal(data.mentioned_actions.length,1);assert.equal(data.mentioned_actions[0].source.start_ms,3000);
  assert.equal(data.open_actions.length,0);assert.match(data.scope,/may already be complete/);
});
