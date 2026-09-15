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
    finalizing:false,appState:'stopping',sessionStats:{completeFrames:2,packetsReceived:8},
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
