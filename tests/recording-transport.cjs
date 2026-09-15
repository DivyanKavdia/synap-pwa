'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const tick=()=>new Promise(setImmediate);
function harness(){
  let clock=10000,id=0,disconnects=0;
  const timers=new Map(),logs=[];
  const c={Promise,Error,Boolean,Math,Date,performance:{now:()=>clock},
    document:{visibilityState:'visible'},recordingConfirmed:true,appState:'recording',lastAudioAt:10000,
    AUDIO_STALL_TIMEOUT_MS:12000,COMMAND_TIMEOUT_MS:3500,recordingSessionId:1,
    connectionEpoch:0,gattQueue:Promise.resolve(),
    log:(message,detail)=>logs.push({message,detail}),
    setTimeout(fn,ms){timers.set(++id,{fn,at:clock+ms});return id},clearTimeout(id){timers.delete(id)},
    bluetoothDevice:{gatt:{connected:true,disconnect(){disconnects++;this.connected=false}}},
    disconnectGatt(reason,device=c.bluetoothDevice){logs.push({reason});device.gatt.disconnect()},
    isGattConnected:()=>c.bluetoothDevice.gatt.connected
  };
  c.window=c;vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','recording/bluetooth-session.js'),'utf8'),c);
  vm.runInContext(source.slice(source.indexOf('  function withTimeout('),source.indexOf('  async function writeCommand(')),c);
  async function expire(ms=3500){clock+=ms;for(const [key,timer] of [...timers]){if(timer.at<=clock){timers.delete(key);timer.fn()}}await tick()}
  return {c,logs,expire,get disconnects(){return disconnects},set clock(value){clock=value}};
}
test('a delayed GATT read cannot disconnect a recording with arriving audio',async()=>{
  const h=harness();let finish;
  const pending=h.c.queueGattOperation(()=>new Promise(resolve=>{finish=resolve}),'Read diagnostics');
  const failed=assert.rejects(pending,{name:'TimeoutError'});await tick();
  h.c.lastAudioAt=13400;await h.expire();await failed;
  assert.equal(h.disconnects,0,'audio transport must survive the diagnostic timeout');
  finish('late');await tick();
});
test('timed-out native work retains the GATT queue and expired queued commands never run later',async()=>{
  const h=harness();let finish,writes=0;
  const read=h.c.queueGattOperation(()=>new Promise(resolve=>{finish=resolve}),'Read status');
  const readFailure=assert.rejects(read,{name:'TimeoutError'});await tick();h.c.lastAudioAt=13400;await h.expire();await readFailure;
  const queued=h.c.queueGattOperation(()=>{writes++},'Queued command');
  const queuedFailure=assert.rejects(queued,{name:'TimeoutError'});await tick();
  assert.equal(writes,0,'native operation still owns transport after caller timeout');
  h.c.lastAudioAt=16900;await h.expire();await queuedFailure;
  finish('late result');await tick();assert.equal(writes,0,'expired command stays cancelled');
  await h.c.queueGattOperation(()=>{writes++},'New command');assert.equal(writes,1);
});
test('hidden recording tolerates a delayed callback, but idle and stopping still recover a stuck link',async()=>{
  for(const state of ['recording','idle','stopping']){
    const h=harness();h.c.appState=state;h.c.document.visibilityState='hidden';h.clock=100000;
    const pending=h.c.queueGattOperation(()=>new Promise(()=>{}),'Blocked request');
    const failed=assert.rejects(pending,{name:'TimeoutError'});await tick();await h.expire();await failed;
    assert.equal(h.disconnects,state==='recording'?0:1,state);
  }
});
test('a stale timeout cannot disconnect the replacement connection',async()=>{
  const h=harness();h.c.appState='idle';
  const pending=h.c.queueGattOperation(()=>new Promise(()=>{}),'Old read');
  const failed=assert.rejects(pending,{name:'TimeoutError'});await tick();h.c.connectionEpoch++;
  await h.expire();await failed;assert.equal(h.disconnects,0);
});
test('a late success from the old connection is rejected',async()=>{
  const h=harness();let finish;
  const pending=h.c.queueGattOperation(()=>new Promise(resolve=>{finish=resolve}),'Old read');
  const failed=assert.rejects(pending,/connection changed/i);await tick();h.c.connectionEpoch++;
  finish('old status');await failed;
});
test('a camera request gets its full native deadline after waiting behind another operation',async()=>{
  const h=harness();let finishRead,finishCamera;
  const read=h.c.queueGattOperation(()=>new Promise(resolve=>{finishRead=resolve}),'Read status');
  const camera=h.c.queueGattOperation(()=>new Promise(resolve=>{finishCamera=resolve}),'Read camera image');
  // Attach a rejection handler before advancing time, so the regression is an assertion failure.
  const result=camera.then(value=>({value}),error=>({error}));
  await tick();await h.expire(3000);assert.equal(finishCamera,undefined);
  finishRead();await read;await tick();await h.expire(1000);
  finishCamera('image bytes');assert.deepEqual(await result,{value:'image bytes'});
  assert.equal(h.disconnects,0);
});
test('a queued timeout identifies its blocker and recovers a link that became idle',async()=>{
  const h=harness();let finish;
  const read=h.c.queueGattOperation(()=>new Promise(resolve=>{finish=resolve}),'Read old status');
  const readFailure=assert.rejects(read,{name:'TimeoutError'});await tick();h.c.lastAudioAt=13400;
  await h.expire();await readFailure;assert.equal(h.disconnects,0);
  h.c.appState='idle';let writes=0;
  const camera=h.c.queueGattOperation(()=>{writes++},'Read camera image');
  const failure=assert.rejects(camera,/waiting for Bluetooth.*timed out/);
  await tick();await h.expire();await failure;
  assert.equal(h.disconnects,1);assert.equal(writes,0);
  assert(h.logs.some(entry=>entry.detail?.blockedBy==='Read old status'));
  finish();await tick();assert.equal(writes,0);
});
