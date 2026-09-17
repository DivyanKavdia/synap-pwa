import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from '@google-cloud/firestore';
import { setFirestoreForTest } from '../src/store/firestore.js';
import { sharedModelCooldown, deferSharedModel } from '../src/store/model-cooldown.js';
import { config } from '../src/config.js';
import { createInteraction } from '../src/gemini/client.js';

// No process-local timing is shared by these readers; only the durable document.
test('a project cooldown survives a fresh reader, cannot be shortened, and prevents model submissions',async t=>{
  const rows=new Map<string,any>();
  const ref=(path:string):any=>({path,doc:(id:string)=>ref(path+'/'+id),get:async()=>({data:()=>rows.get(path)})});
  setFirestoreForTest({collection:ref,runTransaction:async(fn:any)=>fn({get:(r:any)=>r.get(),set:(r:any,value:any)=>rows.set(r.path,value)})} as unknown as Firestore);
  const previous=config.gemini.sharedCooldown;Object.assign(config.gemini,{sharedCooldown:true});
  t.after(()=>{setFirestoreForTest(null);Object.assign(config.gemini,{sharedCooldown:previous});});
  t.mock.method(Date,'now',()=>1000);
  await deferSharedModel('fixture-stt',{retryAfterMs:3600000,quotaKind:'daily'});
  await deferSharedModel('fixture-stt',{retryAfterMs:60000,quotaKind:'rate'});
  assert.deepEqual(await sharedModelCooldown('fixture-stt',2000),{retryAfterMs:3599000,quotaKind:'daily'});
  assert.equal(await sharedModelCooldown('other-model'),undefined);
  assert.equal(await sharedModelCooldown('fixture-stt',3601000),undefined);
  assert.deepEqual([...rows.values()],[{until:3601000,quotaKind:'daily'}]);
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('cooldown must stop before paid submission');});
  await assert.rejects(createInteraction({model:'fixture-stt',input:'fixture',usage_label:'transcription'}),{status:429,rateLimit:{retryAfterMs:3600000,quotaKind:'daily'}});
});
