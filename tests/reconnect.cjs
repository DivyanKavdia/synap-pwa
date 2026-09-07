// Dependency-free regression checks: node tests/reconnect.cjs
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');

assert(!html.slice(html.indexOf('<header'),html.indexOf('</header>')).includes('id="installButton"'));
assert(html.slice(html.indexOf('<dialog id="settingsDialog"'),html.indexOf('</dialog>')).includes('id="installButton"'));
assert.match(html,/id="installButton"[^>]*type="button"[^>]*>[\s\S]*?Install app<\/button>/);

const recoverySource=app.slice(app.indexOf('  async function restoreKnownPendant()'),app.indexOf('  async function connectPendant('));
const connectSource=app.slice(app.indexOf('  async function connectPendant('),app.indexOf('  async function disconnectPendant('));

function context(devices=[]){
  const saved=new Map(),calls=[],listeners={},control={checked:true,addEventListener(t,f){listeners.preference=f;}};
  const c={firmwareBusy:false,console,Boolean,Number,String,Date,Error,Promise,
    navigator:{bluetooth:{getDevices:async()=>devices,addEventListener(t,f){listeners[t]=f;}}},
    document:{visibilityState:'visible',getElementById:id=>id==='autoReconnectInput'?control:{set textContent(v){calls.push(['status',v]);}},addEventListener(t,f){listeners[t]=f;}},
    window:{isSecureContext:true,addEventListener(t,f){listeners[t]=f;},setTimeout(f,ms){calls.push(['timer',ms]);return 1;}},
    localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},connectionEpoch:0,bluetoothDevice:null,connectInProgress:false,manualDisconnect:false,finalizing:false,currentRecordingId:null,reloadRecoveryRunning:false,lastReloadRecoveryAt:0,reconnectTimer:null,reconnectAttempts:0,MAX_AUTO_RECONNECT_ATTEMPTS:3,clearTimeout(){},
    log(label,message){if(label==='Reconnect')calls.push(['reconnect-note',message]);},toast(){},friendlyError:e=>e.message,isGattConnected:()=>false,
    attachBluetoothDevice(d){c.bluetoothDevice=d;},connectPendant:async opts=>calls.push(['connect',opts])};
  vm.createContext(c);vm.runInContext(recoverySource,c);return{c,calls,saved,listeners,control};
}

async function recoveryTests(){
  const pendant={id:'known',name:'dk-pendant'};let t=context([pendant]);
  t.saved.set('dk-pendant-device-id','known');assert.equal(await t.c.restoreKnownPendant(),true);assert.equal(t.c.bluetoothDevice,pendant);
  t=context([pendant]);assert.equal(await t.c.restoreKnownPendant(),true);
  const renamed={id:'renamed',name:'synap'};t=context([renamed]);assert.equal(await t.c.restoreKnownPendant(),true);
  t=context([renamed,pendant]);assert.equal(await t.c.restoreKnownPendant(),false);
  t=context([renamed,pendant]);t.saved.set('dk-pendant-device-id','renamed');assert.equal(await t.c.restoreKnownPendant(),true);
  t=context([pendant,{id:'other',name:'dk-pendant'}]);assert.equal(await t.c.restoreKnownPendant(),false);
  t=context([pendant]);t.saved.set('dk-pendant-device-id','revoked');assert.equal(await t.c.restoreKnownPendant(),false);
  t=context();delete t.c.navigator.bluetooth.getDevices;assert.equal(await t.c.restoreKnownPendant(),false);
  t=context();t.c.navigator.bluetooth.getDevices=async()=>{throw new Error('permission denied');};assert.equal(await t.c.restoreKnownPendant(),false);
  t=context([pendant]);await t.c.recoverRememberedConnection('page-load',true);assert.equal(t.c.reloadRecoveryRunning,false);
}

async function connectionTest({fail=false,reselect=false,auto=false,orphan=false,cancel=false,missing=false}={}){
  const calls=[],characteristic=name=>({addEventListener(){},async startNotifications(){calls.push(name+' notify');}}),audio=characteristic('audio'),control=characteristic('control');
  const device={id:'known',gatt:{connected:false,async connect(){calls.push('connect');if(fail)throw new Error('timeout');this.connected=true;return this;},disconnect(){this.connected=false;},async getPrimaryService(){return{async getCharacteristic(id){return id==='audio'?audio:control;}};}}};
  const c={rememberDeviceAssociation(){},console,Boolean,Error,checkFirmwareRelease:null,connectInProgress:false,finalizing:false,needsDeviceSelection:reselect,bluetoothDevice:missing?null:device,manualDisconnect:false,connectionEpoch:0,gattServer:null,
    navigator:{bluetooth:{requestDevice(){calls.push('chooser');return cancel?Promise.reject(Object.assign(new Error('cancel'),{name:'NotFoundError'})):Promise.resolve(device);}}},SERVICE_UUID:'service',AUDIO_CHAR_UUID:'audio',CONTROL_CHAR_UUID:'control',CMD_STOP:0,CMD_GET_STATUS:2,DEVICE_STATE:{CONNECTED_IDLE:1,STREAMING:2,ERROR:3},deviceStatus:{state:orphan?2:1,error:0},clearReconnectTimer(){},setReconnectCapability(){},setAppState(s){c.state=s;},log(){},toast(){},cleanupCharacteristics(){c.connectionEpoch++;},attachBluetoothDevice(d){c.bluetoothDevice=d;},withTimeout:p=>p,isGattConnected:()=>Boolean(c.bluetoothDevice?.gatt.connected),queueGattOperation:f=>f(),handleAudioNotification(){},handleStatusNotification(){},delay:async()=>{},writeCommand:async cmd=>{calls.push('command '+cmd);if(cmd===0)c.deviceStatus.state=1;},readControlStatus:async()=>{},reconnectAttempts:0,localStorage:{setItem(){}},friendlyError:e=>e.message,scheduleAutoReconnect(){calls.push('retry');}};
  vm.createContext(c);vm.runInContext(connectSource,c);await c.connectPendant({autoReconnect:auto,silent:auto});assert(!calls.includes('command 1'));assert.equal(c.connectInProgress,false);
  if(missing&&auto)return;if(fail){assert.equal(c.state,'disconnected');}else if(!cancel){assert.equal(c.state,'idle');assert(calls.indexOf('audio notify')<calls.indexOf('command 2'));}
}

async function workerTests(){
  const handlers={},entries=new Map(),scope='https://example.test/ai-pendant-app/';let installed=[],job;
  const cache={async addAll(paths){installed=Array.from(paths);for(const p of paths)entries.set(new URL(p,scope).href,p);},async match(key){return entries.get(typeof key==='string'?key:key.url);},async put(key,value){entries.set(typeof key==='string'?key:key.url,value);}};
  const ctx={URL,Set,Promise,self:{registration:{scope},location:{origin:'https://example.test'},addEventListener(t,f){handlers[t]=f;},skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{open:async()=>cache,keys:async()=>[],delete:async()=>{}},fetch:async()=>{throw new Error('unexpected fetch');},Response:{error:()=>({error:true})}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'),ctx);handlers.install({waitUntil:p=>job=p});await job;
  installed.forEach(p=>assert(fs.existsSync(path.join(root,p.split('?')[0]))));
  assert(installed.includes('./runtime-compat.js'));assert(installed.includes('./processing-recovery.js'));assert(installed.includes('./dashboard-ui.js'));assert(installed.includes('./ask-synap.js'));assert(installed.includes('./sleep-state-guard.js'));assert(installed.includes('./transcript-repair.js'));
  async function fetch(url,mode='navigate',method='GET'){let result;handlers.fetch({request:{url,mode,method},respondWith:p=>result=p});return result;}
  assert.equal(await fetch(scope+'?from=home'),'./index.html');
  let reply;handlers.message({data:{type:'GET_VERSION'},source:{postMessage:d=>reply=d}});
  assert.equal(reply.type,'APP_VERSION');assert.equal(reply.version,'1.0.0');assert.equal(reply.release,'1.0.0');assert.equal(reply.revision,'1.0.0-audio2');assert.equal(reply.shellRevision,'1.0.0-shell34-transcript');
}

(async()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  for(const m of app.matchAll(/getElementById\("([^"]+)"\)/g))assert(ids.includes(m[1]),'missing DOM '+m[1]);
  await recoveryTests();
  for(const options of [{},{reselect:true},{auto:true},{orphan:true},{fail:true,auto:true},{reselect:true,cancel:true},{fail:true},{auto:true,missing:true}])await connectionTest(options);
  await workerTests();
  console.log('PASS: reconnect, DOM and Synap 1.0.0 worker checks.');
})().catch(e=>{console.error(e);process.exitCode=1;});