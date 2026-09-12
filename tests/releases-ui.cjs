const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const source=app.slice(app.indexOf('  function bindFirmwareUpdate()'),app.indexOf('  async function registerServiceWorker()'));
function setup(options={}){
  const nodes=new Map(),events={},calls=[],storage=new Map();let connected=true,clock=100000,build=503;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',files:[],disabled:false,checked:false,hidden:false,textContent:'',events:{},
    removeAttribute(name){delete this[name];},hasAttribute(name){return Object.hasOwn(this,name);},
    addEventListener(t,f){(this.events[t]??=[]).push(f);}});return nodes.get(id);};
  function progressMatches(message,value){
    assert.equal(node('firmwareNoticeText').textContent,message);assert.equal(node('otaStatus').textContent,message);
    assert.equal(node('firmwareNotice').hidden,false);assert.equal(node('firmwareUpdateSpinner').hidden,false);
    for(const id of ['otaLatest','firmwareUpdateButton'])assert.equal(node(id).hidden,true,'no update offer while a transfer is active');
    for(const id of ['otaProgress','firmwareNoticeProgress']){assert.equal(node(id).hidden,false);if(value===null)assert.equal(node(id).hasAttribute('value'),false);else assert.equal(node(id).value,value);}
  }
  const m={version:'1.0.0',build:1001,identity:'SYNAP-FW:esp32s3-fh4r2-qspi-4m:1.0.0:1001'};
  const ID='SYNAP-AABBCCDDEEFF',OTHER='SYNAP-112233445566';
  if(options.pending)storage.set('synap-ota-pending-device:'+ID,JSON.stringify({...m,size:1000}));
  class Client {
    constructor(io){this.io=io;this.committing=false;}reset(){}cancel(){calls.push('cancel');}
    async check(){calls.push('check');if(c.firmwareBusy&&!calls.includes('download'))progressMatches('Preparing update…',null);return{protocol:options.legacy?2:3,deviceId:options.wrongIdentity?OTHER:c.deviceAssociation?.deviceId,state:options.resumeState?3:1,session:options.resumeState?55:0,offset:options.resumeState?500:0,build,capacity:2048,maxData:503};}
    async update(blob,id){assert.equal(id,ID);assert(c.firmwareBusy);calls.push('flash');
      if(options.pause){connected=false;const e=Error('paused');e.resumable=true;throw e;}
      this.io.progress('Updating · 50%',0.5,false);progressMatches('Updating · 50%',0.5);assert.equal(node('otaCancel').disabled,false);
      for(const fn of node('firmwareUpdateButton').events.click)await fn();assert.equal(calls.filter(call=>call==='flash').length,1,'duplicate clicks cannot start another update');
      if(options.flashFail)throw Error('Flash failed');
      this.io.progress('Restarting pendant…',1,true);progressMatches('Restarting pendant…',1);assert(node('otaCancel').disabled);
      this.committing=true;connected=false;
      if(options.commitDrop)throw Error('Lost acknowledgement');return{committed:true};}
  }
  const releases={IDENTITY_UUID:'identity',validateManifest:m=>m,
    latest:async()=>{assert(!c.firmwareBusy,'release discovery must not interrupt recording or FIFO processing');calls.push('manifest');if(options.offline)throw Error('Offline');return m;},
    compatible:(m,info)=>m.build>info.build,
    download:async(_manifest,_capacity,_fetcher,signal)=>{calls.push('download');progressMatches('Downloading update…',null);
      if(options.cancelDownload){for(const fn of node('otaCancel').events.click)await fn();progressMatches('Cancelling transfer…',null);assert(signal.aborted);throw Error('Download cancelled');}
      if(options.badDownload)throw Error('SHA-256 mismatch');
      if(options.disconnectDownload){connected=false;c.connectionEpoch++;}
      if(options.switchDownload)c.deviceAssociation={deviceId:OTHER};return{};}};
  const c={firmwareControlsBound:false,appLockHeld:true,deviceAssociation:options.noIdentity?null:{deviceId:ID},console,Promise,Error,TextDecoder,AbortController,Date:{now:()=>clock},globalThis:{SynapOTA:{Client,MIGRATION_MESSAGE:'Install by USB once'},SynapReleases:releases},
    document:{getElementById:node,visibilityState:'visible',addEventListener(t,f){events[t]=f;}},window:{confirm:message=>{assert(message.includes(ID));return !options.decline;}},
    ui:{chooseDeviceButton:node('choose'),runQueueButton:node('queue'),queueStatus:node('queueStatus'),settingsDialog:node('settingsDialog')},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    firmwareUpdater:null,firmwareBusy:false,checkFirmwareRelease:null,connectionEpoch:0,bluetoothDevice:{id:'device',gatt:{disconnect:()=>connected=false}},
    isGattConnected:()=>connected,connectInProgress:false,recordingConfirmed:false,finalizing:false,currentRecordingId:null,openingCapture:null,unsavedAudio:false,
    appState:'idle',deviceStatus:{error:0},SERVICE_UUID:'service',queueGattOperation:f=>f(),
    gattServer:{getPrimaryService:async()=>({getCharacteristic:async()=>{
      if(build===503)throw Object.assign(Error('missing'),{name:'NotFoundError'});
      return{readValue:async()=>new TextEncoder().encode(m.identity)};
    }})},
    clearReconnectTimer(){},setAppState(){},friendlyError:e=>e.message,processor:{pause:()=>calls.push('pause')},
    log(){},openSettings:()=>{calls.push('settings');node('settingsDialog').open=!node('settingsDialog').open;},acquireWakeLock:async()=>{},releaseWakeLock:async()=>calls.push('release'),
    delay:async ms=>clock+=ms,setInterval:f=>events.timer=f,
    connectPendant:async()=>{calls.push('reconnect');progressMatches('Reconnecting to verify update…',1);if(!options.reconnectFail){connected=true;build=options.oldBuild?503:1001;
      if(options.changedHandle)c.bluetoothDevice.id='new-browser-handle';
      if(options.switchedPendant)c.deviceAssociation={deviceId:OTHER};}},
    recoverRememberedConnection:()=>calls.push('recover')};
  vm.createContext(c);vm.runInContext(source,c);c.bindFirmwareUpdate();
  node('settingsDialog').open=!!options.settingsOpen;
  return {c,node,calls,storage,click:async id=>{for(const fn of node(id).events.click||[])await fn();},tick:()=>events.timer()};
}
(async()=>{
  let t=setup();await t.click('otaReleaseCheck');assert.match(t.node('firmwareNoticeText').textContent,/1001.*available/);
  await t.click('firmwareUpdateButton');
  assert(t.calls.includes('flash'));assert(t.calls.includes('reconnect'));assert.match(t.node('otaStatus').textContent,/Update complete/);assert.equal(t.storage.size,0);assert(!t.c.firmwareBusy);
  assert(t.node('firmwareUpdateSpinner').hidden);assert(t.node('firmwareNoticeProgress').hidden);assert(t.node('firmwareUpdateButton').hidden);assert(t.node('settingsDialog').open);
  t=setup({settingsOpen:true});await t.click('otaReleaseCheck');await t.click('otaLatest');assert(t.node('settingsDialog').open,'starting inside Settings keeps it open');assert(!t.calls.includes('settings'),'the update must not toggle Settings closed');
  t=setup({commitDrop:true});await t.click('otaReleaseCheck');await t.click('otaLatest');assert.match(t.node('otaStatus').textContent,/Update complete/);
  t=setup({flashFail:true});await t.click('otaReleaseCheck');await t.click('otaLatest');assert.match(t.node('otaStatus').textContent,/Flash failed/);assert(!t.c.firmwareBusy);assert(t.node('otaCancel').hidden);assert(t.node('otaProgress').hidden);assert(t.node('firmwareNoticeProgress').hidden);assert(t.node('firmwareUpdateSpinner').hidden);assert.equal(t.node('firmwareUpdateButton').hidden,false);assert(t.calls.includes('release'));
  for(const options of [{noIdentity:true},{wrongIdentity:true},{legacy:true},{badDownload:true},{cancelDownload:true},{disconnectDownload:true},{switchDownload:true}]){
    t=setup(options);await t.click('otaReleaseCheck');await t.click('otaLatest');assert(!t.calls.includes('flash'),JSON.stringify(options));assert(!t.c.firmwareBusy);
  }
  for(const flag of ['recordingConfirmed','finalizing','currentRecordingId','openingCapture','unsavedAudio','connectInProgress']){
    t=setup();await t.click('otaReleaseCheck');t.c[flag]=true;t.node('settingsDialog').open=true;await t.click('otaLatest');assert(!t.calls.includes('flash'),flag);assert(t.node('settingsDialog').open,'blocked update keeps the explanation visible');
  }
  t=setup();t.c.appLockHeld=false;await t.click('otaReleaseCheck');await t.click('otaLatest');assert(!t.calls.includes('flash'),'firmware requires this tab to own the pendant');assert.match(t.node('otaStatus').textContent,/Close other Synap tabs/);
  t=setup({oldBuild:true});await t.click('otaReleaseCheck');await t.click('otaLatest');assert.match(t.node('otaStatus').textContent,/not confirmed/);assert.equal(t.storage.size,1);assert(t.storage.has('synap-ota-pending-device:SYNAP-AABBCCDDEEFF'));
  t=setup({changedHandle:true});await t.click('otaReleaseCheck');await t.click('otaLatest');assert.match(t.node('otaStatus').textContent,/Update complete/);
  t=setup({switchedPendant:true});await t.click('otaReleaseCheck');await t.click('otaLatest');assert.match(t.node('otaStatus').textContent,/original pendant device ID/);assert.equal(t.storage.size,1);
  t=setup({reconnectFail:true});await t.click('otaReleaseCheck');await t.click('otaLatest');assert.match(t.node('otaStatus').textContent,/not confirmed/);assert(t.calls.includes('recover'));
  t=setup({offline:true});await t.click('otaReleaseCheck');assert(!t.calls.includes('flash'));assert.match(t.node('otaStatus').textContent,/Offline/);
  t=setup({pending:true,resumeState:true,pause:true});await t.click('otaReleaseCheck');
  assert.match(t.node('otaLatest').textContent,/Continue/);assert(!t.calls.includes('manifest'),'resume does not switch release images');
  await t.click('otaLatest');assert.equal(t.storage.size,1,'resumable interruption keeps checkpoint');assert(t.calls.includes('recover'));
  assert(t.node('firmwareNoticeProgress').hidden);assert(t.node('firmwareUpdateSpinner').hidden);assert.equal(t.node('firmwareUpdateButton').textContent,'Continue update');
  console.log('PASS: device-ID discovery/targeting, eligibility, hash failure, connection race, commit loss, persistent target, reboot verification and failure retention.');
})().catch(e=>{console.error(e);process.exitCode=1;});
