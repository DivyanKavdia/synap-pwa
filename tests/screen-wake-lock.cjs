const {test}=require('node:test'),assert=require('node:assert/strict');
const ScreenWakeLock=require('../recording/screen-wake-lock.js');
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture(navigator){
  let scope='firmware',next=0;const timers=new Map(),logs=[];
  const controller=new ScreenWakeLock({navigator,scope:()=>scope,log:(message)=>logs.push(message),
    timers:{setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)}});
  return{controller,logs,scope:value=>scope=value,expire:async()=>{const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();await settle();}};
}
function sentinel({hang=false}={}){
  const events={};let releases=0;
  return{release:()=>{releases++;return hang?new Promise(()=>{}):Promise.resolve();},
    addEventListener:(name,fn)=>events[name]=fn,released:()=>events.release?.(),count:()=>releases};
}

test('Bluefy acquisition is shared and a completed lease restores screen dimming',async()=>{
  const calls=[],reply=deferred(),t=fixture({bluetooth:{setScreenDimEnabled:value=>{calls.push(value);return value?Promise.resolve():reply.promise;}}});
  const first=t.controller.acquire();assert.equal(t.controller.acquire(),first);
  await settle();assert.deepEqual(calls,[false]);reply.resolve();await first;
  await t.controller.release();assert.deepEqual(calls,[false,true]);assert.equal(t.controller.owner,null);
});

test('a Bluefy request that never replies times out and permits the standard wake lock fallback',async()=>{
  const calls=[],lock=sentinel(),t=fixture({bluetooth:{setScreenDimEnabled:value=>{calls.push(value);return new Promise(()=>{});}},wakeLock:{request:async()=>lock}});
  const pending=t.controller.acquire();await settle();await t.expire();await pending;
  assert.equal(t.controller.owner.lock,lock);assert.deepEqual(calls,[false,true]);
  await t.controller.release();assert.equal(lock.count(),1);await t.expire();
});

test('a late standard wake-lock reply is released after timeout without replacing a newer lease',async()=>{
  const late=deferred(),oldLock=sentinel(),newLock=sentinel();let count=0;
  const t=fixture({wakeLock:{request:()=>++count===1?late.promise:Promise.resolve(newLock)}});
  const pending=t.controller.acquire();await settle();await t.expire();await pending;
  t.scope('recording:2');await t.controller.acquire();late.resolve(oldLock);await settle();
  assert.equal(oldLock.count(),1);assert.equal(t.controller.owner.lock,newLock);
  await t.controller.release();assert.equal(newLock.count(),1);
});

test('a native release that never replies is bounded and cannot clear a newer lease',async()=>{
  const oldLock=sentinel({hang:true}),newLock=sentinel();let count=0;
  const t=fixture({wakeLock:{request:async()=>++count===1?oldLock:newLock}});
  await t.controller.acquire();const releasing=t.controller.release();
  assert.equal(t.controller.owner,null);t.scope('recording:3');await t.controller.acquire();
  oldLock.released();assert.equal(t.controller.owner.lock,newLock);
  await t.expire();await releasing;await t.controller.release();
});

test('a late Bluefy reply cannot re-enable dimming during a newer recording',async()=>{
  const calls=[],late=deferred();let disables=0;
  const t=fixture({bluetooth:{setScreenDimEnabled:value=>{calls.push(value);return !value&&++disables===1?late.promise:Promise.resolve();}}});
  const pending=t.controller.acquire();await settle();await t.expire();await pending;
  t.scope('recording:4');await t.controller.acquire();assert.deepEqual(calls,[false,true,false]);
  late.resolve();await settle();assert.deepEqual(calls,[false,true,false]);
  await t.controller.release();assert.deepEqual(calls,[false,true,false,true]);
});

test('ending the session while the browser is deciding releases the late resource',async()=>{
  const reply=deferred(),lock=sentinel(),t=fixture({wakeLock:{request:()=>reply.promise}});
  const pending=t.controller.acquire();await settle();t.scope(null);reply.resolve(lock);await pending;await settle();
  assert.equal(lock.count(),1);assert.equal(t.controller.owner,null);
});

test('release before a queued Bluefy request runs prevents a stale disable request',async()=>{
  const calls=[],t=fixture({bluetooth:{setScreenDimEnabled:async value=>calls.push(value)}});
  const pending=t.controller.acquire();await t.controller.release();await pending;
  assert(!calls.includes(false));assert.equal(t.controller.owner,null);
});
