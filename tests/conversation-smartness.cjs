'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),test=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../brain-ui.js'),'utf8');
function fixture(){const reads=[],nodes={'#datePicker':{value:'2026-09-10'},'#dayBriefText':{textContent:'',classList:{toggle(){}}},'#dayBriefStatus':{}};
  const context={Date,console,setTimeout,clearTimeout,localStorage:{getItem:()=>null},
    document:{readyState:'loading',addEventListener(){},querySelector:s=>nodes[s]||null,querySelectorAll:()=>[]},
    indexedDB:{open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction:()=>({objectStore:()=>({getAll(){const read={};reads.push(read);return read}})})};request.onsuccess()});return request}}};
  vm.runInNewContext(source,context);return{api:context.SynapBrainUI,reads,nodes};}
test('conversation facts retain full summaries, precise source time and explicit attendance',()=>{
  const{api}=fixture(),summary='A long conversation. '+ 'All of this context matters. '.repeat(30)+'Final detail.';
  const model=api.conversationModel({id:'r',createdAt:'2026-09-10T10:00:00Z'},{title:'Plan',summary,start_seconds:92.5,participants:['self','Alex','alex',null,5],people:[{name:'Mentioned only'}],decisions:[{text:'Ship Friday'}],action_items:[{task:'Test',owner:'self',due_date:'Friday'}],follow_ups:[{text:'Confirm',owner:'Alex'}]});
  assert.equal(model.summary,summary);assert.equal(model.startMs,92500);assert.deepEqual(Array.from(model.participants),['You','Alex']);
  assert.equal(model.decisions[0],'Ship Friday');assert.equal(model.actions[0].meta,'You · Friday');assert.equal(model.followUps[0].text,'Confirm');
  assert.equal(api.conversationModel({id:'r',createdAt:'2026-09-10'},{people:[{name:'Mentioned'}]}).participants.length,0);
  assert.equal(api.summaryOf({meeting:{conversations:[{summary:'First.'},{summary:'Last.'}]}}),'First.\n\nLast.');
  assert.equal(api.summaryOf({summary:'Fallback',meeting:{executive_summary:summary}}),summary);
});
test('late database reads cannot replace newer summaries; read failure retains last good day',async()=>{
  const{api,reads,nodes}=fixture();
  const first=api.refresh(),second=api.refresh();await new Promise(resolve=>setImmediate(resolve));
  reads[1].result=[{id:'new',createdAt:'2026-09-10T10:00:00Z',summary:'Latest full summary.'}];reads[1].onsuccess();await second;
  reads[0].result=[{id:'old',createdAt:'2026-09-10T10:00:00Z',summary:'Stale summary.'}];reads[0].onsuccess();await first;
  assert.equal(nodes['#dayBriefText'].textContent,'Latest full summary.');
  const failed=api.refresh();await new Promise(resolve=>setImmediate(resolve));reads[2].error=Error('Read failed');reads[2].onerror();await failed;
  assert.equal(nodes['#dayBriefText'].textContent,'Latest full summary.');assert.match(nodes['#dayBriefStatus'].textContent,/could not refresh/);
  nodes['#datePicker'].value='2026-09-09';const older=api.refresh();await new Promise(resolve=>setImmediate(resolve));reads[3].result=[{id:'prior',createdAt:'2026-09-09T10:00:00Z',summary:'Prior day.'}];reads[3].onsuccess();await older;
  assert.equal(nodes['#dayBriefText'].textContent,'Prior day.');assert.equal(nodes['#dayBriefStatus'].hidden,true);
});
