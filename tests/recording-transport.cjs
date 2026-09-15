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
test('Start waits for slow native discovery without disconnecting or overlapping ATT',async()=>{
  const h=harness();h.c.appState='idle';h.c.recordingConfirmed=false;
  let finish,started=0;
  const discovery=h.c.queueGattOperation(()=>new Promise(resolve=>{finish=resolve}),'Find voice control');
  await tick();h.c.appState='starting';
  const start=h.c.queueGattOperation(()=>{started++;},'Start recording');
  const settled=Promise.all([discovery,start]);
  await h.expire(5000);
  assert.equal(h.disconnects,0);assert.equal(started,0);
  finish('characteristic');await settled;
  assert.equal(started,1);assert.equal(h.disconnects,0);
});
test('discovery still has a bounded deadline when the native bridge never replies',async()=>{
  const h=harness();h.c.appState='idle';
  const pending=h.c.queueGattOperation(()=>new Promise(()=>{}),'Find voice control');
  const failed=assert.rejects(pending,{name:'TimeoutError'});
  await tick();await h.expire(10000);await failed;assert.equal(h.disconnects,1);
});
test('native string, null and code-only failures retain useful diagnostics',async()=>{
  for(const [reason,message] of [['Operation failed (code 2).',/code 2/],[null,/Bluetooth request failed/],[{code:6},/code 6/]]){
    const h=harness();
    await assert.rejects(h.c.queueGattOperation(()=>Promise.reject(reason),'Read camera response'),message);
    const failure=h.logs.find(row=>row.message==='GATT operation failed');
    assert.match(failure.detail.message,message);assert.equal(failure.detail.name,'Error');
  }
});

test('simultaneous startup discovery and subscriptions keep their own native deadlines',async()=>{
  const h=harness();h.c.appState='idle';h.c.recordingConfirmed=false;
  let finishDiscovery,subscribed=0;
  const discovery=h.c.queueGattOperation(()=>new Promise(resolve=>{finishDiscovery=resolve}),'Find firmware status');
  // These callers enqueue in the same turn, before discovery enters the native bridge.
  const subscribe=h.c.queueGattOperation(()=>{subscribed++;return 'subscribed'},'Subscribe pendant events');
  const result=Promise.all([discovery,subscribe]).then(value=>({value}),error=>({error}));
  await tick();await h.expire(5000);
  assert.equal(h.disconnects,0,'waiting for healthy discovery must not disconnect an idle pendant');
  assert.equal(subscribed,0);
  finishDiscovery('characteristic');
  assert.deepEqual(await result,{value:['characteristic','subscribed']});
});

test('a startup backlog can exceed one deadline while every native request is healthy',async()=>{
  const h=harness();h.c.appState='idle';h.c.recordingConfirmed=false;
  const finishes=[],order=[];
  const requests=['Find module characteristic','Find pendant events','Find firmware status'].map(label=>
    h.c.queueGattOperation(()=>new Promise(resolve=>{order.push(label);finishes.push(resolve)}),label));
  const result=Promise.all(requests).then(value=>({value}),error=>({error}));
  for(let i=0;i<3;i++){
    await tick();await h.expire(6000);
    assert.equal(h.disconnects,0,'18 seconds of progressing setup is not a stuck native request');
    assert.equal(order.length,i+1,'only one native request owns ATT');
    finishes[i](i);await tick();
  }
  assert.deepEqual(await result,{value:[0,1,2]});
});

// Exercise the media client's deadline through the real device policy and
// native queue, rather than passing a longer timeout directly to the queue.
function camera(h) {
  const Client=require('../devices/chakshu/transfer.js').Client;
  let request,finishRead,reads=0,writes=0;
  const service={async getCharacteristic(uuid){
    if(uuid.startsWith('4fa12354'))return {
      properties:{writeWithoutResponse:true},
      async writeValueWithoutResponse(bytes){writes++;request=new DataView(bytes.buffer);}
    };
    return {readValue(){
      reads++;
      const reply=new DataView(new ArrayBuffer(16));
      [0xcb,1,1,0].forEach((v,i)=>reply.setUint8(i,v));
      reply.setUint32(4,request.getUint32(2,true),true);
      return new Promise(resolve=>{finishRead=()=>resolve(reply)});
    }};
  }};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','devices/identity.js'),'utf8'),h.c);
  h.c.SynapDevices.publishService(service,h.c.queueGattOperation,()=>{},()=>true,()=>true);
  return {client:new Client(h.c.SynapDevices.connection),finish:()=>finishRead(),
    get reads(){return reads},get writes(){return writes}};
}
test('a camera read taking six seconds survives while idle, without retrying its command',async()=>{
  const h=harness();h.c.appState='idle';h.c.recordingConfirmed=false;
  const f=camera(h),result=f.client.request(2,960).then(value=>({value}),error=>({error}));
  await tick();assert.equal(f.reads,1);
  await h.expire(6000);f.finish();
  assert.equal((await result).error,undefined);
  assert.equal(h.disconnects,0);assert.equal(f.writes,1);
});
test('cancelling a slow camera read keeps native ownership until Stop can run safely',async()=>{
  const h=harness(),f=camera(h),controller=new AbortController();let stops=0;
  const read=f.client.request(2,960,'',controller.signal);
  const failed=assert.rejects(read,{name:'AbortError'});await tick();
  controller.abort();h.c.appState='stopping';
  const stop=h.c.queueGattOperation(()=>{stops++;},'Control command 0x0');
  const result=stop.then(value=>({value}),error=>({error}));
  await h.expire(6000);
  assert.equal(stops,0,'Stop must not overlap the unresolved native read');
  f.finish();await failed;
  assert.equal((await result).error,undefined);assert.equal(stops,1);
  assert.equal(f.writes,1);assert.equal(h.disconnects,0);
});
test('a camera read that never returns still recovers the idle link within ten seconds',async()=>{
  const h=harness();h.c.appState='idle';h.c.recordingConfirmed=false;
  const f=camera(h),pending=f.client.request(2,960);
  const failed=assert.rejects(pending,{name:'TimeoutError'});await tick();
  await h.expire(9999);assert.equal(h.disconnects,0);
  await h.expire(1);await failed;assert.equal(h.disconnects,1);assert.equal(f.writes,1);
  f.finish();await tick();
});
