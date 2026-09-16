'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function load(file){const c={document:{readyState:"loading",addEventListener(){},getElementById(){return null},querySelector(){return null}},Blob,DataView,Uint8Array,DOMException,URL,setTimeout,clearTimeout};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8'),c);return c}
test('recording quality flags actual clipping and quiet audio without changing PCM',()=>{
  const api=load('audio-quality.js').SynapAudioQuality;
  const pcm=new Uint8Array(96000),v=new DataView(pcm.buffer);for(let i=0;i<pcm.length;i+=2)v.setInt16(i,32767,true);
  api.observe(pcm);assert(api.describe(api.snapshot()).some(s=>s.includes('clipping')));assert.equal(v.getInt16(0,true),32767);
  api.reset();api.observe(new Uint8Array(96000));assert(api.describe(api.snapshot()).some(s=>s.includes('Almost no microphone signal')));
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

test('recap and next conversation use saved evidence, preserve owners and omit resolved agenda items',()=>{
  const api=load('meeting-tools.js').SynapMeetingTools;
  const c={title:'Launch',summary:'Pilot planned.',start_ms:2000,key_facts:[{text:'Budget ₹5,000',start_ms:4000}],risks:[{text:'Approval pending',start_ms:6000}],action_items:[{task:'Send plan',owner:'self',due_date:'2026-09-20',start_ms:8000}],unresolved_questions:[{text:'Who approves?',start_ms:10000},{text:'Resolved question',state:'resolved'}],follow_ups:[{text:'Who approves?',start_ms:11000},{text:'Check venue',owner:'Priya',start_ms:12000},{text:'Already done',status:'done'}]};
  assert.deepEqual(Array.from(api.agenda(c),i=>i.text),['Who approves?','Check venue']);
  const recap=api.recap({name:'Planning',meeting:{executive_summary:'Pilot planned.',conversations:[c]}});
  assert.match(recap,/Key facts\n- Budget ₹5,000 \[0:04\]/);
  assert.match(recap,/Risks & blockers\n- Approval pending/);
  assert.match(recap,/Send plan — You · 2026-09-20 \[0:08\]/);
  assert.equal(recap.split('Who approves?').length,2);
  assert.doesNotMatch(recap,/Already done|Resolved question/);
  assert.equal(api.recap({name:'Old memory',summary:'Existing summary'}),'Old memory\n\nExisting summary');
});
