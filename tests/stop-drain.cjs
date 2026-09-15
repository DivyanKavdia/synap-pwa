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
