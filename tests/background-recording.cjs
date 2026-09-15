'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const block=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to));
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function activity() {
  let now=10000,wall=100000;
  const calls={flush:0,subscribe:0,replay:[],stop:0,events:0,errors:[]};
  const target={async startNotifications(){calls.subscribe++;}};
  const c={console,Promise,DOMException,Date:class extends Date{static now(){return wall;}},
    CustomEvent:class{constructor(type){this.type=type;}},performance:{now:()=>now},
    document:{visibilityState:'visible',body:{dataset:{}}},window:{dispatchEvent(){calls.events++;}},
    recordingSessionId:1,currentRecordingId:'same-take',recordingConfirmed:true,recordingStartedAt:100,recordingStoppedAt:null,
    recordingStopRequested:false,recordingReconnectPending:false,finalizing:false,connectionEpoch:1,
    appState:'recording',lastCompleteAudioAt:10000,lastCompleteSequence:41,lastObservedSequence:41,
    backgroundCapture:null,backgroundRecoveryPromise:null,foregroundAt:10000,
    AUDIO_STALL_TIMEOUT_MS:12000,FOREGROUND_STALL_GRACE_MS:12000,sessionStats:{completeFrames:40},
    audioCharacteristic:target,journal:{async flush(){calls.flush++;}},
    SynapDisconnectProtection:{lastSequence:()=>c.lastCompleteSequence,capacityMs:()=>30000,
      async replay(sequence,valid){assert(valid());calls.replay.push(sequence);return true;}},
    isCurrentSession:id=>id===c.recordingSessionId,isGattConnected:()=>true,
    queueGattOperation:fn=>Promise.resolve().then(fn),log(){},toast(){},friendlyError:e=>e.message,
    handleStorageError:e=>calls.errors.push(e),stopRecording:async()=>{calls.stop++;},ui:{timer:{textContent:''}}};
  vm.createContext(c);
  vm.runInContext(block('  function setAudioDelivery(', '  function clearReconnectTimer('),c);
  vm.runInContext(block('  function updateTimer()', '  async function acquireWakeLock()'),c);
  return {c,calls,advance(ms){now+=ms;wall+=ms;},hide(){c.document.visibilityState='hidden';c.checkpointBackgroundRecording();},
    show(){c.document.visibilityState='visible';c.foregroundAt=now;c.restoreBackgroundRecording();},
    frame(seq){c.sessionStats.completeFrames++;c.recordCompleteAudio(seq);},async done(){await settle();await c.backgroundRecoveryPromise;await settle();}};
}

test('background checkpoint flushes storage without stopping or changing the recording',async()=>{
  const t=activity();t.hide();t.c.checkpointBackgroundRecording();await t.done();
  assert.equal(t.calls.flush,2);assert.equal(t.c.backgroundCapture.lastSequence,41);
  assert.equal(t.calls.stop,0);assert.equal(t.c.currentRecordingId,'same-take');
  assert.equal(t.c.appState,'recording');assert.equal(t.calls.subscribe,0);
});

test('a healthy background stream keeps its subscriptions and never requests replay',async()=>{
  const t=activity();t.hide();t.advance(1000);t.frame(42);t.advance(50);t.frame(43);t.show();t.frame(44);await t.done();
  assert.equal(t.c.backgroundCapture,null);assert.deepEqual(t.calls.replay,[]);assert.equal(t.calls.subscribe,0);
});

test('missing background callbacks replay from the last complete frame on the same connection',async()=>{
  const t=activity();t.hide();t.advance(3000);t.show();await t.done();
  assert.deepEqual(t.calls.replay,[41]);assert.equal(t.calls.subscribe,1);assert.equal(t.calls.stop,0);
  assert.equal(t.c.currentRecordingId,'same-take');assert.equal(t.c.document.body.dataset.audioDelivery,'waiting');
  t.frame(42);assert.equal(t.c.document.body.dataset.audioDelivery,'receiving');
});

test('a new live packet before the visibility event cannot move the recovery boundary past the gap',async()=>{
  const t=activity();t.hide();t.advance(3000);t.frame(101);t.frame(102);t.show();await t.done();
  assert.deepEqual(t.calls.replay,[41]);
});

test('the first packet after foregrounding detects loss even when the app switch was short',async()=>{
  const t=activity();t.hide();t.advance(100);t.show();t.frame(45);await t.done();
  assert.deepEqual(t.calls.replay,[41]);
});

test('foreground events share one replay and Stop cancels queued subscription work',async()=>{
  const t=activity(),jobs=[];t.c.queueGattOperation=fn=>new Promise((resolve,reject)=>jobs.push(()=>Promise.resolve().then(fn).then(resolve,reject)));
  t.hide();t.advance(2000);t.show();t.show();await settle();assert.equal(jobs.length,1);
  t.c.recordingStopRequested=true;t.c.appState='stopping';await jobs.shift()();await t.done();
  assert.equal(t.calls.subscribe,0);assert.deepEqual(t.calls.replay,[]);
});

test('the disconnected recorder owns RESUME; foreground does not issue a second recovery',async()=>{
  const t=activity();t.hide();t.advance(2000);t.c.recordingReconnectPending=true;t.show();await t.done();
  assert.equal(t.calls.subscribe,0);assert.deepEqual(t.calls.replay,[]);
});

test('an unobserved half-cycle is saved before counter ambiguity can overwrite old audio',async()=>{
  const t=activity();t.hide();t.advance(32768*50);t.show();await t.done();
  assert.equal(t.calls.stop,1);assert.equal(t.calls.subscribe,0);assert.equal(t.c.backgroundCapture,null);
});

test('elapsed time advances independently of audio reception and exposes stalls',()=>{
  const t=activity();t.hide();t.advance(60000);t.c.updateTimer();
  assert.equal(t.c.ui.timer.textContent,'01:09');assert.equal(t.c.document.body.dataset.receivedAudioClock,'00:02');assert.equal(t.c.document.body.dataset.audioDelivery,'waiting');
  assert.equal(t.calls.stop,0,'visibility alone must not stop a browser that can keep delivering audio');
  const events=t.calls.events;t.c.updateTimer();assert.equal(t.calls.events,events,'unchanged delivery status does not churn the DOM');
  t.frame(42);t.c.updateTimer();assert.equal(t.c.document.body.dataset.audioDelivery,'receiving');
});

test('Bluefy dimming control is released when recording ends, including an interrupted acquisition',async()=>{
  const calls=[],navigator={bluetooth:{setScreenDimEnabled:async value=>calls.push(value)}};let scope='recording:1';
  const ScreenWakeLock=require('../recording/screen-wake-lock.js');
  const c={screenWakeLock:new ScreenWakeLock({navigator,scope:()=>scope})};vm.createContext(c);
  vm.runInContext(block('  async function acquireWakeLock()', '  function drawWaveform()'),c);
  await c.acquireWakeLock();assert(c.screenWakeLock.owner.bluefy);await c.releaseWakeLock();
  assert.deepEqual(calls,[false,true]);assert.equal(c.screenWakeLock.owner,null);
  navigator.bluetooth.setScreenDimEnabled=async value=>{calls.push(value);scope=null;};
  await c.acquireWakeLock();await settle();assert.deepEqual(calls,[false,true,false,true]);assert.equal(c.screenWakeLock.owner,null);
});

function protection({supported=true,acknowledge=true,ack=0}={}) {
  const calls=[],state={armed:false,hash:0,ack,generation:7,waiting:false,finishing:false},owner=[];
  const value=()=>{const v=new DataView(new ArrayBuffer(16));v.setUint8(0,0x52);v.setUint8(1,1);
    v.setUint8(2,1+(state.armed?2:0)+(state.waiting?4:0)+(state.finishing?8:0)+(supported?16:0));
    v.setUint8(3,state.ack);v.setUint16(4,600,true);v.setUint32(8,state.generation,true);v.setUint32(12,state.hash,true);return v;};
  let pending=0,reads=0,listener=null;
  const characteristic={addEventListener(type,fn){listener=fn;},removeEventListener(){listener=null;},async startNotifications(){},
    async readValue(){reads++;if(pending && --pending===0)state.ack=(state.ack+1)&255;return value();},
    async writeValueWithResponse(bytes){calls.push(bytes[0]);
      if(bytes[0]===1){owner.splice(0,owner.length,...bytes.slice(1));state.armed=true;let hash=2166136261;for(const b of owner)hash=Math.imul(hash^b,16777619)>>>0;state.hash=hash;}
      if(bytes[0]===3&&acknowledge)pending=3;
    }};
  const c={console,Uint8Array,DataView,Promise,DOMException,CustomEvent:class{},document:{getElementById:()=>null},
    setTimeout:fn=>queueMicrotask(fn),crypto:{getRandomValues:v=>v.fill(9)},dispatchEvent(){}};
  vm.createContext(c);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../disconnect-protection.js'),'utf8'),c);
  return {api:c.SynapDisconnectProtection,calls,state,get reads(){return reads;},notify(){listener?.({target:{value:value()}});},
    async connect(){await this.api.discover({getCharacteristic:async()=>characteristic},fn=>Promise.resolve().then(fn),()=>{});await this.api.arm();}};
}

test('connected replay waits for its own acknowledgement, including acknowledgement wrap',async()=>{
  for(const ack of [0,255]){const t=protection({ack});await t.connect();const reads=t.reads;
    assert.equal(await t.api.replay(41),true);assert(t.reads>=reads+4);assert.deepEqual(t.calls,[1,3]);
    assert.equal(t.state.ack,(ack+1)&255);
  }
});

test('Stop drain acknowledgements belong to the current recovery token and reset between takes',async()=>{
  const t=protection();await t.connect();assert.equal(t.api.isDraining(),false);
  t.state.finishing=true;t.notify();assert.equal(t.api.isDraining(),true);
  t.state.hash^=1;t.notify();assert.equal(t.api.isDraining(),false);
  t.state.hash^=1;t.state.waiting=true;t.notify();assert.equal(t.api.isDraining(),false);
  t.state.waiting=false;t.notify();assert.equal(t.api.isDraining(),true);
  t.api.resetRecording();assert.equal(t.api.isDraining(),false);
  t.notify();t.api.detach();assert.equal(t.api.isDraining(),false);
});

test('old firmware and a finishing or disconnected stream cannot claim connected replay',async()=>{
  const old=protection({supported:false});await old.connect();assert.equal(await old.api.replay(41),false);assert.deepEqual(old.calls,[1]);
  for(const flag of ['waiting','finishing']){const t=protection();await t.connect();t.state[flag]=true;
    assert.equal(await t.api.replay(41),false);assert.deepEqual(t.calls,[1]);}
});

test('an unchanged recovery status is not a replay acknowledgement',async()=>{
  const t=protection({acknowledge:false});await t.connect();await assert.rejects(t.api.replay(41),/not acknowledged/);
});

test('replayed older frames cannot move the reconnect checkpoint backwards',async()=>{
  const t=protection();await t.connect();t.api.received(65534);t.api.received(65535);t.api.received(0);t.api.received(65535);
  assert.equal(t.api.lastSequence(),0);t.api.resetRecording();assert.equal(t.api.lastSequence(),null);
});

test('Stop freezes elapsed time while recovered audio duration can grow',()=>{
  const t=activity();t.c.recordingStoppedAt=11000;t.c.appState='stopping';t.c.updateTimer();
  assert.equal(t.c.ui.timer.textContent,'00:10');t.advance(30000);t.c.sessionStats.completeFrames=200;t.c.updateTimer();
  assert.equal(t.c.ui.timer.textContent,'00:10');assert.equal(t.c.document.body.dataset.receivedAudioClock,'00:10');
});
