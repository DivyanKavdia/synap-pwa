'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8'),app=read('app.js');
const slice=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));
const tick=()=>new Promise(setImmediate);
function harness(){
  const listeners=new Map(),timers=new Map(),calls=[];let timerId=0,active=0,maximum=0;
  const c={console:{warn(){},info(){}},Promise,Error,TextDecoder,Uint8Array,DataView,Date,Math,
    document:{body:{dataset:{state:'idle',deviceState:'1'}},readyState:'complete',addEventListener(){},getElementById(){return null}},
    CustomEvent:class{constructor(type,options={}){this.type=type;this.detail=options.detail}},
    addEventListener(type,fn){const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list)},
    dispatchEvent(event){for(const fn of listeners.get(event.type)||[])fn(event)},
    setTimeout(fn,ms){timers.set(++timerId,{fn,ms});return timerId},clearTimeout(id){timers.delete(id)},
    MutationObserver:class{observe(){}},
    gattQueue:Promise.resolve(),connectionEpoch:0,recordingSessionId:1,COMMAND_TIMEOUT_MS:3500,
    isGattConnected:()=>true,withTimeout:p=>p,log(){},SynapRecordingBridge:{},
    bluetoothDevice:{gatt:{disconnect(){calls.push('disconnect')}}}
  };
  c.globalThis=c;c.window=c;vm.createContext(c);
  vm.runInContext(slice('  function queueGattOperation(', '  async function writeCommand('),c);
  vm.runInContext(read('device-identity.js'),c);
  vm.runInContext(read('event-channel.js'),c);
  const battery=read('battery-popover-fix.js');vm.runInContext(battery.slice(battery.indexOf('/* Standby requires')),c);
  async function io(name,value){active++;maximum=Math.max(maximum,active);calls.push(name);await tick();active--;return value}
  const events=new Set();
  const eventCharacteristic={addEventListener(t,f){events.add(f)},removeEventListener(t,f){events.delete(f)},startNotifications:()=>io('notify'),readValue:()=>io('event-read',new DataView(new ArrayBuffer(0)))};
  const control={properties:{write:true},writeValueWithResponse:value=>io('standby:'+Array.from(value).join(','))};
  const service={getCharacteristic:uuid=>io('find:'+uuid,uuid.includes('1234e')?eventCharacteristic:control)};
  function publish(next=service){const epoch=c.connectionEpoch;c.SynapDevices.publishService(next,c.queueGattOperation,()=>{if(epoch!==c.connectionEpoch)throw Error('stale')})}
  return {c,calls,timers,events,io,publish,eventCharacteristic,get maximum(){return maximum}};
}
test('events, power and recorder commands serialize on one GATT queue',async()=>{
  const h=harness();h.publish();
  h.c.dispatchEvent(new h.c.CustomEvent('synap-event-packet',{detail:{hex:'e2 01 01 00 82 04'}}));
  const standby=[...h.timers.values()].find(t=>t.ms===30000);assert(standby);
  const first=h.c.SynapEventChannel.attach(),second=h.c.SynapEventChannel.attach();assert.equal(first,second,'one subscription attempt');
  await Promise.all([first,standby.fn(),h.c.queueGattOperation(()=>h.io('status'))]);
  assert.equal(h.maximum,1);assert.equal(h.calls.filter(x=>x==='notify').length,1);
  assert(h.calls.includes('standby:3,2'),'idle standby must get past its own busy guard');
});
test('queued standby is cancelled if recording starts while discovery is pending',async()=>{
  const h=harness();h.publish();h.c.dispatchEvent(new h.c.CustomEvent('synap-event-packet',{detail:{hex:'e2 01 01 00 82 04'}}));
  const standby=[...h.timers.values()].find(t=>t.ms===30000).fn();
  h.c.document.body.dataset.state='recording';await standby;
  assert(!h.calls.some(x=>x.startsWith('standby:')));
});
test('disconnect invalidates retained service, subscription and late operations',async()=>{
  const h=harness();h.publish();const old=h.c.SynapDevices.connection;
  const pending=h.c.SynapEventChannel.attach();await tick();
  h.c.connectionEpoch++;h.c.SynapDevices.clearService();
  assert.equal(h.c.SynapDevices.connection,null);assert.equal(h.c.SynapEventChannel.mode,'none');
  await pending;assert.equal(h.events.size,0);assert.equal(h.c.SynapEventChannel.mode,'none');
  let ran=false;await assert.rejects(old.queue(()=>{ran=true}),/stale/);assert.equal(ran,false);
  h.publish();await h.c.SynapEventChannel.attach();assert.equal(h.c.SynapEventChannel.mode,'event');assert.equal(h.events.size,1);
});
test('firmware without EVENT falls back once without a subscription retry loop',async()=>{
  const h=harness();h.publish({getCharacteristic(){throw Object.assign(Error('missing'),{name:'NotFoundError'})}});
  await h.c.SynapEventChannel.attach();assert.equal(h.c.SynapEventChannel.mode,'legacy-control');
  const count=h.timers.size;await h.c.SynapEventChannel.attach();assert.equal(h.timers.size,count);
});
test('recording retries cover the recovery window while idle retries remain bounded',()=>{
  const timers=[],c={manualDisconnect:false,autoReconnectEnabled:()=>true,bluetoothDevice:{},reconnectAttempts:8,MAX_AUTO_RECONNECT_ATTEMPTS:8,reconnectTimer:null,recordingReconnectPending:false,AUTO_RECONNECT_DELAYS_MS:[1200,2600,5200,10000,15000,20000,30000,30000],log(){},window:{setTimeout(fn,ms){timers.push({fn,ms});return 1}}};
  vm.createContext(c);vm.runInContext(slice('  function scheduleAutoReconnect()', '  async function connectPendant('),c);
  c.scheduleAutoReconnect();assert.equal(timers.length,0);
  c.recordingReconnectPending=true;c.scheduleAutoReconnect();assert.equal(timers[0].ms,30000);
  c.reconnectTimer=null;c.manualDisconnect=true;c.scheduleAutoReconnect();assert.equal(timers.length,1);
});
test('capture metrics batch frame updates and the clock only writes changed seconds',()=>{
  const timers=[];let renders=0,writes=0,text='00:01';
  const c={metricsTimer:null,window:{setTimeout(fn){timers.push(fn);return timers.length}},renderMetrics(){renders++},recordingConfirmed:true,recordingStartedAt:1,performance:{now:()=>1501},ui:{timer:{get textContent(){return text},set textContent(v){text=v;writes++}}},formatClock:()=> '00:01',appState:'starting'};
  vm.createContext(c);vm.runInContext(slice('  function updateMetrics()', '  function renderMetrics()'),c);
  for(let i=0;i<20;i++)c.updateMetrics();assert.equal(timers.length,1);timers[0]();assert.equal(renders,1);
  vm.runInContext(slice('  function updateTimer()', '  function formatClock('),c);for(let i=0;i<5;i++)c.updateTimer();assert.equal(writes,0);
});
test('appearance leaves processing locks to runtime compatibility; leases exclude overlapping work',async()=>{
  const storage=new Map(),intervals=new Map();let id=0;
  const localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  function page(owner){
    const c={navigator:{},localStorage,crypto:{randomUUID:()=>owner},Date,Math,Promise,Set,Object,TypeError,setTimeout,
      setInterval(fn){intervals.set(++id,fn);return id},clearInterval:id=>intervals.delete(id),addEventListener(){},
      document:{readyState:'loading',documentElement:{dataset:{},style:{},setAttribute(){}},querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){}}};
    c.window=c;c.root=c;c.navigatorObject=c.navigator;vm.createContext(c);vm.runInContext(read('theme.js'),c);
    assert.equal(c.navigator.locks,undefined);
    const runtime=read('runtime-compat.js');vm.runInContext(runtime.slice(runtime.indexOf('  function installWebLocksFallback()'),runtime.indexOf('  function bindSettingsSafetyNet()'))+'\ninstallWebLocksFallback();',c);
    return c;
  }
  const a=page('a'),b=page('b');let finish;
  const held=a.navigator.locks.request('processing',()=>new Promise(resolve=>{finish=resolve}));
  await a.navigator.locks.request('processing',{ifAvailable:true},lock=>assert.equal(lock,null,'same page cannot reenter'));
  await b.navigator.locks.request('processing',{ifAvailable:true},lock=>assert.equal(lock,null,'second page waits'));
  finish();await held;
  await b.navigator.locks.request('processing',{ifAvailable:true},lock=>assert.equal(lock.name,'processing'));
  assert.equal(storage.size,0,'released lease is removed');
});
test('long captures accept a wrapped firmware counter with bounded duplicate memory',()=>{
  const c={PCM_BYTES_PER_FRAME:1600,RECENT_FRAME_WINDOW:512,Uint8Array,completedSequences:new Set(),journal:{},sessionStats:{completeFrames:0,pcmBytes:0},updateAudioLevel(){},updateMetrics(){},log(){}};
  vm.createContext(c);vm.runInContext(slice('  function completeFrame(', '  function cleanupStaleFrames('),c);
  const pcm=new Uint8Array(1600);
  for(let frame=0;frame<65538;frame++){
    const sequence=frame&0xffff;assert(!c.completedSequences.has(sequence),'a new frame cannot collide with an old counter cycle');
    c.completeFrame({sequence,receivedBytes:1600,totalChunks:1,chunks:[pcm]});
    assert(c.completedSequences.has(sequence),'a repeated notification is still rejected');
  }
  assert.equal(c.sessionStats.completeFrames,65538);assert.equal(c.completedSequences.size,512);
});
test('a queued resume rechecks the recording before writing START',async()=>{
  const jobs=[];let writes=0,expired=false;
  const c={controlCharacteristic:{properties:{write:true},async writeValueWithResponse(){writes++}},isGattConnected:()=>true,PROTOCOL_VERSION:2,Uint8Array,log(){},
    queueGattOperation(action){return new Promise((resolve,reject)=>jobs.push(()=>Promise.resolve().then(action).then(resolve,reject)))}
  };
  vm.createContext(c);vm.runInContext(slice('  async function writeCommand(', '  async function readControlStatus('),c);
  const pending=c.writeCommand(1,()=>{if(expired)throw Error('recording expired')});
  expired=true;await jobs.shift()();await assert.rejects(pending,/recording expired/);assert.equal(writes,0);
  const valid=c.writeCommand(1,()=>{});await jobs.shift()();await valid;assert.equal(writes,1);
  assert.match(app,/resumingSessionId !== null && \(finalizing \|\| !isCurrentSession\(resumingSessionId\)\)/);
  assert.match(app,/writeCommand\(CMD_START, assertConnection\)/);
});
