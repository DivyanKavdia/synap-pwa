'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','productivity-tools.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const waitRefresh=()=>new Promise(resolve=>setTimeout(resolve,90));
const record=(id,createdAt,title=id)=>({id,createdAt,name:id,meeting:{conversations:[{title,summary:'Grounded conversation',start_ms:1200}]}});

class Element {
  constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attributes={};this.handlers={};this.hidden=false;this.value='';this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(node=>node.textContent||'').join('');}
  append(...nodes){this.children.push(...nodes);}
  appendChild(node){this.append(node);return node;}
  replaceChildren(...nodes){this.children=nodes;this._text='';}
  setAttribute(key,value){this.attributes[key]=String(value);}
  addEventListener(name,handler){(this.handlers[name]||=[]).push(handler);}
  dispatch(name,event={}){for(const handler of this.handlers[name]||[])handler({currentTarget:this,target:this,...event});}
  dispatchEvent(event){this.dispatch(event.type,event);}
  click(){this.dispatch('click');this.onclick?.({currentTarget:this,target:this});}
}

function setup(initial=[]){
  let rows=initial,manual=false;const reads=[],events={},documentEvents={},opened=[];
  const nodes=new Map(['datePicker','synapWeeklyReview','synapWeekRange','synapWeekNarrative','synapWeekMetrics','synapWeekDetail','synapCalendarAll','synapDueList','synapWeekMore','synapWeekCount','synapWeekStatus'].map(id=>[id,new Element()]));
  nodes.get('datePicker').value='2026-09-10';
  const document={readyState:'loading',getElementById:id=>id==='synap-productivity-style'?new Element():nodes.get(id)||null,
    querySelector:selector=>selector==='.day-brief'?new Element():nodes.get(selector.slice(1))||null,
    createElement:tag=>new Element(tag),addEventListener:(name,handler)=>{documentEvents[name]=handler;}};
  const context={document,console,Date,Set,Map,Promise,Object,Array,String,Number,Boolean,Math,Intl,setTimeout,clearTimeout,
    Event:class{constructor(type){this.type=type;}},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},
    addEventListener:(name,handler)=>{(events[name]||=[]).push(handler)},dispatchEvent:event=>{for(const handler of events[event.type]||[])handler(event)},
    SynapProvenance:{openSource:(...args)=>opened.push(args)},
    indexedDB:{open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction(){return {objectStore(){return {getAll(){const query={};const item={query,rows:structuredClone(rows)};reads.push(item);if(!manual)queueMicrotask(()=>{query.result=item.rows;query.onsuccess?.()});return query;}}}}}};request.onsuccess();});return request;}}
  };
  context.globalThis=context;vm.createContext(context);vm.runInContext(source,context);
  return {api:context.SynapProductivity,context,nodes,reads,opened,
    setRows:value=>{rows=value},setManual:value=>{manual=value},
    resolveRead:index=>{const item=reads[index];item.query.result=item.rows;item.query.onsuccess()},
    rejectRead:index=>{const item=reads[index];item.query.error=new Error('Temporary storage failure');item.query.onerror()},
    init:()=>documentEvents.DOMContentLoaded(),emit:name=>context.dispatchEvent({type:name})};
}
const sources = detail => detail.children.filter(node => node.dataset.recordingId);
function openConversations(h){const metric=h.nodes.get('synapWeekMetrics').children.find(node=>node.dataset.weekView==='conversations');if(metric?.attributes['aria-pressed']!=='true')metric.click();}

test('Weekly Review shows the newest conversation first and paginates older evidence',async()=>{
  const older=Array.from({length:35},(_,i)=>record('older-'+i,'2026-09-08T12:00:00',String(i)));
  const h=setup([...older,record('today','2026-09-10T12:00:00','Today conversation')]);
  await h.api.refresh(false);
  assert.equal(h.nodes.get('synapWeekDetail').hidden,false,'conversations are visible by default');
  openConversations(h);
  const detail=h.nodes.get('synapWeekDetail');
  assert.equal(sources(detail)[0].dataset.recordingId,'today','today is not lost after an unsorted 30-item cutoff');
  assert.equal(sources(detail).length,5,'compact first page');
  while(!h.nodes.get('synapWeekMore').hidden)h.nodes.get('synapWeekMore').click();
  assert.equal(sources(detail).length,36,'every older source remains reachable');
  sources(detail)[0].click();assert.deepEqual(h.opened[0],['today',1200]);
});

test('same-day cloud refresh keeps the weekly conversation list open',async()=>{
  const h=setup([record('today','2026-09-10T12:00:00')]);h.init();await tick();await tick();openConversations(h);
  h.nodes.get('datePicker').dispatch('change',{__synapCloudInternal:true});await tick();await tick();
  assert.equal(h.nodes.get('synapWeekDetail').hidden,false);
  assert.equal(sources(h.nodes.get('synapWeekDetail'))[0].dataset.recordingId,'today');
});

test('a newly processed weekly source refreshes the same-day Library before navigation',async()=>{
  const h=setup(),order=[];
  h.nodes.get('datePicker').addEventListener('change',event=>{assert.equal(event.__synapCloudInternal,true);order.push('library')});
  h.context.SynapProvenance={refresh:async()=>order.push('source index'),openSource:(id,offset)=>order.push(id+':'+offset)};
  await h.api.openSource(record('new-today','2026-09-10T12:00:00'),1200);
  assert.deepEqual(order,['library','source index','new-today:1200']);
});

test('an older asynchronous read cannot erase a freshly processed conversation',async()=>{
  const h=setup([]);h.setManual(true);
  const old=h.api.refresh(false);await tick();
  h.setRows([record('today','2026-09-10T12:00:00')]);
  const fresh=h.api.refresh(false);await tick();h.resolveRead(1);await fresh;
  assert.match(h.nodes.get('synapWeekMetrics').textContent,/1 conversation/);
  h.resolveRead(0);await old;
  assert.match(h.nodes.get('synapWeekMetrics').textContent,/1 conversation/,'late stale read must be ignored');
});

test('processing completion refreshes weekly evidence without a reload',async()=>{
  const h=setup([]);h.init();await tick();await tick();
  h.setRows([record('today','2026-09-10T12:00:00')]);h.emit('synap-processing-complete');await waitRefresh();
  assert.match(h.nodes.get('synapWeekMetrics').textContent,/1 conversation/);
});

test('a failed local reload preserves already visible conversations and shows an error',async()=>{
  const h=setup([record('today','2026-09-10T12:00:00')]);await h.api.refresh(false);
  h.setManual(true);const pending=h.api.refresh(false);await tick();h.rejectRead(1);await pending;
  assert.match(h.nodes.get('synapWeekMetrics').textContent,/1 conversation/);
  assert.equal(h.nodes.get('synapWeekStatus').hidden,false);
  assert.match(h.nodes.get('synapWeekStatus').textContent,/Could not refresh/);
  h.setManual(false);await h.api.refresh(false);
  assert.equal(h.nodes.get('synapWeekStatus').hidden,true,'a successful local read clears its previous error');
});

test('cloud restore explicitly reports skipped requests so weekly hydration can retry',async()=>{
  const h=setup();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','cloud-history.js'),'utf8'),h.context);
  const result=await h.context.SynapCloudHistory.restore(true,{day:'2026-09-10',transcript:false});
  assert.equal(result.skipped,true);
});

test('failed or skipped cloud day restores are retryable rather than cached as complete',async()=>{
  for(const failed of [{error:new Error('offline')},{skipped:true}]){
    const h=setup();let calls=0;
    h.context.SynapAuth={isSignedIn:()=>true};h.context.SynapCloudHistory={busy:()=>false,restore:async()=>{calls++;return calls===1?failed:{restored:0,updated:0};}};
    const range=h.api.weekRange('2026-09-10');await h.api.hydrateWeek(range);await h.api.hydrateWeek(range);
    assert(calls>7,'an incomplete week must be attempted again');
  }
});

test('changing weeks during cloud hydration also fetches the newly selected week',async()=>{
  const h=setup(),days=[];let release;
  const gate=new Promise(resolve=>{release=resolve});
  h.context.SynapAuth={isSignedIn:()=>true};h.context.SynapCloudHistory={busy:()=>false,restore:async(_,options)=>{days.push(options.day);if(days.length===1)await gate;return {restored:0,updated:0};}};
  const first=h.api.hydrateWeek(h.api.weekRange('2026-08-31'));
  const second=h.api.hydrateWeek(h.api.weekRange('2026-09-10'));release();await Promise.all([first,second]);
  assert(days.includes('2026-09-10'),'today’s week must not be skipped behind a prior-week request');
  assert.equal(days.length,14);
});

test('week boundaries are local Monday through Sunday; unprocessed audio is not a conversation',()=>{
  const h=setup();
  for(const value of ['2026-09-07','2026-09-10','2026-09-13']){
    const range=h.api.weekRange(value);assert.equal(range.start,'2026-09-07');assert.equal(range.end,'2026-09-13');assert.equal(h.api.weekDays(range).length,7);
  }
  assert.equal(h.api.weekRange('2026-09-14').start,'2026-09-14');
  const summary=h.api.buildWeekSummary([{id:'pending',createdAt:'2026-09-10T12:00:00',processingStage:'transcribing'}],h.api.weekRange('2026-09-10'));
  assert.equal(summary.conversations,0,'no invented conversation while processing');
});

test('UTC timestamps on either side of local midnight use the correct weekly window',async()=>{
  const h=setup([
    record('before',new Date(2026,8,6,23,59).toISOString()),
    record('monday',new Date(2026,8,7,0,1).toISOString()),
    record('sunday',new Date(2026,8,13,23,59).toISOString()),
    record('after',new Date(2026,8,14,0,1).toISOString())
  ]);
  await h.api.refresh(false);
  assert.match(h.nodes.get('synapWeekMetrics').textContent,/2 conversations/);
  assert.deepEqual(sources(h.nodes.get('synapWeekDetail')).map(node=>node.dataset.recordingId),['sunday','monday']);
});
