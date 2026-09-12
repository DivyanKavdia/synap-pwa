'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
require('../audio-store.js');
function fixture(){
  const requests=[];
  const store=new DKAudioStore({indexedDB:{open(){const request={};requests.push(request);return request}}});
  return{store,requests,db(){return{closed:0,close(){this.closed++}}}};
}
test('a rejected storage open can be retried on the same journal',async()=>{
  const t=fixture(),first=t.store.open(),error=new Error('Storage temporarily unavailable');
  t.requests[0].error=error;t.requests[0].onerror();await assert.rejects(first,error);
  const retry=t.store.open(),db=t.db();assert.equal(t.requests.length,2);
  t.requests[1].result=db;t.requests[1].onsuccess();assert.equal(await retry,db);
  assert.equal(await t.store.open(),db);assert.equal(t.requests.length,2,'success keeps one connection');
});
test('a blocked open cannot leak a late connection into a retried journal',async()=>{
  const t=fixture(),blocked=t.store.open();t.requests[0].onblocked();await assert.rejects(blocked,/upgrade blocked/);
  const retry=t.store.open(),old=t.db(),current=t.db();
  t.requests[0].result=old;t.requests[0].onsuccess();assert.equal(old.closed,1);
  t.requests[1].result=current;t.requests[1].onsuccess();assert.equal(await retry,current);
  assert.equal(await t.store.open(),current);assert.equal(current.closed,0);
});
test('a version change invalidates the closed storage connection',async()=>{
  const t=fixture(),first=t.store.open(),db=t.db();t.requests[0].result=db;t.requests[0].onsuccess();await first;
  db.onversionchange();assert.equal(db.closed,1);
  const next=t.store.open(),upgraded=t.db();assert.equal(t.requests.length,2);
  t.requests[1].result=upgraded;t.requests[1].onsuccess();assert.equal(await next,upgraded);
});
