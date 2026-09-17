import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from '@google-cloud/firestore';
import { setFirestoreForTest } from '../src/store/firestore.js';
import { sharedModelCooldown, deferSharedModel } from '../src/store/model-cooldown.js';
import { config } from '../src/config.js';
import { createInteraction, GeminiError, modelFailure } from '../src/gemini/client.js';

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
  assert.deepEqual([...rows.values()],[{until:3601000,quotaKind:'daily',failures:1,lastRejectedAt:1000}]);
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('cooldown must stop before paid submission');});
  await assert.rejects(createInteraction({model:'fixture-stt',input:'fixture',usage_label:'transcription'}), error => {
    assert(error instanceof GeminiError);
    const failure = modelFailure(error);
    assert.equal(failure.code, 'processing_deferred');
    assert.equal(failure.providerStatus, undefined);
    assert.equal(failure.modelStage, 'transcription');
    return failure.retryAfterMs === 3600000;
  });
});

test('durable backoff survives separate workers without counting readers or concurrent failures again', async t => {
  const rows = new Map<string, any>();
  const ref = (path: string): any => ({ path, doc: (id: string) => ref(path + '/' + id), get: async () => ({ data: () => rows.get(path) }) });
  setFirestoreForTest({ collection: ref, runTransaction: async (fn: any) => fn({ get: (r: any) => r.get(), set: (r: any, value: any) => rows.set(r.path, value) }) } as unknown as Firestore);
  t.after(() => setFirestoreForTest(null));
  const advice = { retryAfterMs: 60000, quotaKind: 'rate' as const };
  let now = 1000;
  for (const delay of [60000, 120000, 240000, 480000, 900000, 900000]) {
    assert.equal((await deferSharedModel('shared-stt', advice, now)).retryAfterMs, delay);
    assert.equal((await deferSharedModel('shared-stt', advice, now)).retryAfterMs, delay);
    const before = JSON.stringify([...rows.values()]);
    for (let read = 1; read <= 5; read++)
      assert.equal((await sharedModelCooldown('shared-stt', now + read))?.retryAfterMs, delay - read);
    assert.equal(JSON.stringify([...rows.values()]), before, 'status checks cannot extend cooldown');
    now += delay;
  }
  assert.equal((await deferSharedModel('shared-stt', advice, now + 3600000)).retryAfterMs, 60000);
});
