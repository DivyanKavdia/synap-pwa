'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('moments.js','utf8');
function fixture(){
  const records=new Map([['current',{id:'current',status:'recording',notes:'keep me'}],['older',{id:'older',status:'saved'}]]),events=[];
  let active={active:true,recordingId:'current',offsetMs:1250},failure=false,legacy=[],queue=Promise.resolve();
  const store={atomic:(_names,action)=>{const operation=queue.then(()=>new Promise((resolve,reject)=>{
    if(failure){reject(Error('Storage unavailable'));return;}
    let result,aborted=false;
    action({recordings:{get(id){const request={};queueMicrotask(()=>{request.result=records.get(id);request.onsuccess();if(!aborted)resolve(result)});return request},put(r){records.set(r.id,r)}}},value=>result=value,{abort(){aborted=true;reject(Error('Recording ended'))}});
  }));queue=operation.catch(()=>{});return operation}};
  const c={crypto:require('node:crypto').webcrypto,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}},dispatchEvent:e=>events.push(e),localStorage:{getItem:()=>JSON.stringify(legacy)}};
  vm.createContext(c);vm.runInContext(source,c);c.SynapMoments.configure({store,context:()=>active});
  return{api:c.SynapMoments,records,events,setActive:v=>active=v,fail:()=>failure=true,legacy:v=>legacy=v};
}
test('marks persist atomically on the active recording, preserving other fields',async()=>{
  const t=fixture();await Promise.all([t.api.mark(),t.api.mark()]);
  const r=t.records.get('current');assert.equal(r.rememberMarkers.length,2);assert.equal(r.notes,'keep me');assert.equal(r.rememberMarkers[0].offsetMs,1250);assert.equal(r.rememberMarkers[0].source,'pwa');assert(!t.records.get('older').rememberMarkers);assert.equal(t.events.length,2);
});
test('idle, ended and failed storage cannot report a successful mark',async()=>{
  for(const kind of ['idle','ended','failure']){const t=fixture();if(kind==='idle')t.setActive({active:false});if(kind==='ended')t.records.get('current').status='saved';if(kind==='failure')t.fail();await assert.rejects(t.api.mark());assert.equal(t.events.length,0);assert(!t.records.get('older').rememberMarkers);}
});
test('hardware duplicates are stored and announced only once',async()=>{
  const t=fixture();await t.api.mark({eventKey:'r:7:2000'});await t.api.mark({eventKey:'r:7:2000'});assert.equal(t.records.get('current').rememberMarkers.length,1);assert.equal(t.events.length,1);assert.equal(t.events[0].detail.source,'pendant');
});
test('legacy timestamps are recovered only for their recording; idle markers are excluded',()=>{
  const t=fixture(),id=require('node:crypto').randomUUID();t.legacy([{id,recordingId:'current',offsetSeconds:3.5,source:'live-capture'},{id:require('node:crypto').randomUUID(),recordingId:'current',offsetSeconds:null},{id:require('node:crypto').randomUUID(),recordingId:'older',offsetSeconds:9}]);
  const saved=t.api.markers(t.records.get('current'));assert.equal(saved.length,1);assert.equal(saved[0].offsetMs,3500);assert.equal(saved[0].source,'pwa');
});
