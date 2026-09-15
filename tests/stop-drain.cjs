'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const block=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));

test('control reads repair a command echo once and require a real status acknowledgement',async()=>{
  for(const mode of ['status','echo','invalid','replaced']){
    const echo=new DataView(new Uint8Array([0,mode==='invalid'?9:2]).buffer);
    const status=new DataView(new ArrayBuffer(16));let reads=0;const writes=[],parsed=[];
    const c={DOMException,PROTOCOL_VERSION:2,CMD_STOP:0,CMD_START:1,CMD_GET_STATUS:2,
      connectionEpoch:1,isGattConnected:()=>true,log(){},friendlyError:String,
      queueGattOperation:fn=>Promise.resolve().then(fn),delay:async()=>{},
      controlCharacteristic:{readValue:async()=>++reads===1||mode==='echo'?echo:status},
      parseStatusValue:value=>{parsed.push(value.byteLength);return value.byteLength===16;},
      writeCommand:async(command,before)=>{if(mode==='replaced')c.connectionEpoch++;before();writes.push(command);}};
    vm.createContext(c);vm.runInContext(block('  async function readControlStatus(', '  function handleStatusNotification('),c);
    assert.equal(await c.readControlStatus(),mode==='status');
    assert.deepEqual(writes,mode==='invalid'||mode==='replaced'?[]:[2]);
    assert.equal(reads,mode==='invalid'||mode==='replaced'?1:2);
    assert.deepEqual(parsed,mode==='replaced'?[]:[mode==='status'?16:2]);
  }
});

test('a Stop click and reconnect finishing share one drain per connection and recording',async()=>{
  const pending=[];
  const c={recordingReconnectPending:false,appState:'recording',recordingSessionId:3,connectionEpoch:7,
    recordingStopOperation:null,
    drainRecordingStop:()=>{c.appState='stopping';return new Promise(resolve=>pending.push(resolve));}};
  vm.createContext(c);vm.runInContext(block('  async function stopRecording(', '  async function drainRecordingStop('),c);
  const first=c.stopRecording();const same=c.stopRecording(true);assert.equal(pending.length,1);
  c.connectionEpoch++;const replacement=c.stopRecording(true);assert.equal(pending.length,2);
  pending[0]();await Promise.all([first,same]);assert.equal(c.recordingStopOperation.epoch,8);
  pending[1]();await replacement;assert.equal(c.recordingStopOperation,null);
});

function stopWatch() {
  let now=1000,id=0;const timers=new Map(),saved=[],disconnects=[];
  const c={recordingStopWatch:null,recordingStopRequested:true,recordingSessionId:3,
    finalizing:false,appState:'stopping',recordingReconnectPending:false,connectInProgress:false,sessionStats:{completeFrames:2,packetsReceived:8},
    document:{body:{dataset:{}}},performance:{now:()=>now},log(){},toast(){},
    isCurrentSession:session=>session===c.recordingSessionId,
    isGattConnected:()=>c.appState!=='disconnected',
    disconnectGatt:reason=>{disconnects.push(reason);c.appState='disconnected';},
    clearReconnectTimer(){},finalizeRecording:async(reason,session)=>{saved.push({reason,session});},
    clearInterval:key=>timers.delete(key),window:{setInterval(fn){timers.set(++id,fn);return id;}}};
  vm.createContext(c);vm.runInContext(block('  function clearRecordingStopWatch()', '  function scheduleFinalize('),c);
  return {c,saved,disconnects,timers,tick(ms){now+=ms;for(const fn of [...timers.values()])fn();}};
}

test('Stop has one no-progress deadline across connection cleanup and reconnection',()=>{
  const t=stopWatch();t.c.watchRecordingStop(3);t.tick(3900);
  t.c.appState='disconnected';t.tick(1000);t.c.appState='stopping';t.c.watchRecordingStop(3);
  assert.equal(t.timers.size,1);t.tick(3100);
  assert.deepEqual(t.saved,[{reason:'stop-unconfirmed',session:3}]);
  assert.equal(t.disconnects.length,1);assert.equal(t.timers.size,0);
});

test('Stop saves received audio even when reconnect never succeeds',()=>{
  const t=stopWatch();t.c.watchRecordingStop(3);t.c.appState='disconnected';t.tick(8000);
  assert.equal(t.saved.length,1);assert.equal(t.disconnects.length,0);
});
test('Stop allows a native reconnect handshake to recover audio without resetting its absolute deadline',()=>{
  const t=stopWatch();t.c.watchRecordingStop(3);t.tick(1000);
  t.c.recordingReconnectPending=true;t.c.appState='connecting';t.tick(11000);
  assert.equal(t.saved.length,0,'a 12-second reconnect must keep the journal open');
  t.c.recordingReconnectPending=false;t.c.appState='stopping';t.tick(250);
  t.tick(7000);assert.equal(t.saved.length,0,'the resumed drain gets time for its first frame');
  t.c.sessionStats.completeFrames++;t.tick(7000);assert.equal(t.saved.length,0);
  t.c.sessionStats.completeFrames++;t.tick(9000);assert.equal(t.saved.length,1,'35-second absolute limit still applies');
});

function stopDrain(mode) {
  let connected=true,writes=0,reads=0;const saved=[],disconnects=[],interrupted=[];
  const c={appState:'recording',connectionEpoch:1,recordingStoppedAt:null,recordingStopRequested:false,
    manualDisconnect:false,CMD_STOP:0,performance:{now:()=>100},sessionStats:{completeFrames:399,packetsReceived:1597},
    deviceStatus:{state:2,error:0},DEVICE_STATE:{CONNECTED_IDLE:1},
    SynapDisconnectProtection:{isDraining:()=>false,capacityMs:()=>mode==='no-recovery'?0:30000},
    isCurrentSession:id=>id===3,setAppState:state=>{c.appState=state;},updateTimer(){},clearStartTimeout(){},watchRecordingStop(){},
    delay:async()=>{},isGattConnected:()=>connected,log(){},friendlyError:String,
    markRecordingInterrupted:id=>interrupted.push(id),disconnectGatt:reason=>{disconnects.push(reason);connected=false;},
    finalizeRecording:async(reason,id)=>saved.push({reason,id}),scheduleFinalize:(ms,reason,id)=>saved.push({reason,id}),
    writeCommand:async()=>{
      writes++;
      if(mode==='lost'){connected=false;throw Error('Link lost');}
      if(mode==='rejected'||mode==='no-recovery'||writes===1)throw Error('Bluetooth request failed.');
    },readControlStatus:async()=>{reads++;c.deviceStatus.state=1;return true;}};
  vm.createContext(c);vm.runInContext(block('  async function drainRecordingStop(', '  function clearRecordingStopWatch('),c);
  return {c,saved,disconnects,interrupted,get writes(){return writes;},get reads(){return reads;}};
}
test('a rejected Stop write retries and saves only after the pendant acknowledges idle',async()=>{
  const t=stopDrain('transient');await t.c.drainRecordingStop(3,1);
  assert.equal(t.writes,2);assert.equal(t.reads,1);assert.equal(t.disconnects.length,0);
  assert.deepEqual(t.saved,[{reason:'normal',id:3}]);
});
test('persistent Stop failure preserves the journal for reconnect instead of sealing before disconnect',async()=>{
  const t=stopDrain('rejected');await t.c.drainRecordingStop(3,1);
  assert.equal(t.writes,3);assert.equal(t.disconnects.length,1);
  assert.deepEqual(t.interrupted,[3]);assert.deepEqual(t.saved,[]);
});
test('a Stop write rejected by link loss leaves finalization to recovery and its bounded watchdog',async()=>{
  const t=stopDrain('lost');await t.c.drainRecordingStop(3,1);
  assert.equal(t.writes,1);assert.deepEqual(t.saved,[]);
});
test('firmware without recovery saves received audio after bounded Stop retries',async()=>{
  const t=stopDrain('no-recovery');await t.c.drainRecordingStop(3,1);
  assert.equal(t.writes,3);assert.deepEqual(t.saved,[{reason:'stop-unconfirmed',id:3}]);
});
test('control commands use advertised write-without-response and retain compatibility with write-only firmware',async()=>{
  for(const supportsWithoutResponse of [true,false]) {
    const calls=[];const c={PROTOCOL_VERSION:2,Uint8Array,isGattConnected:()=>true,log(){},queueGattOperation:fn=>fn(),
      controlCharacteristic:{properties:{write:true,writeWithoutResponse:supportsWithoutResponse},
        writeValueWithResponse:async v=>calls.push(['response',...v]),
        writeValueWithoutResponse:async v=>calls.push(['no-response',...v])}};
    vm.createContext(c);vm.runInContext(block('  async function writeCommand(', '  async function readControlStatus('),c);
    await c.writeCommand(0);assert.deepEqual(calls,[[supportsWithoutResponse?'no-response':'response',0,2]]);
  }
});

test('drain progress gets time to recover buffers but cannot extend the absolute deadline',()=>{
  const t=stopWatch();t.c.watchRecordingStop(3);
  for(let i=0;i<4;i++){t.c.sessionStats.completeFrames++;t.tick(7000);assert.equal(t.saved.length,0);}
  t.c.sessionStats.completeFrames++;t.tick(7000);assert.equal(t.saved.length,1);
});

test('Stop watchdog cannot finalize a new recording or interfere with a storage save',()=>{
  for(const mode of ['new','saving']){
    const t=stopWatch();t.c.watchRecordingStop(3);
    if(mode==='new')t.c.recordingSessionId=4;else t.c.finalizing=true;
    t.tick(35000);assert.equal(t.saved.length,0);assert.equal(t.timers.size,0);
  }
});
