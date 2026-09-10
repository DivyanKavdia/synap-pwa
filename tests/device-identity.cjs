const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const devices = require('../device-identity.js');
const A = 'SYNAP-AABBCCDDEEFF', B = 'SYNAP-112233445566';
const value = id => new DataView(new TextEncoder().encode(id).buffer);
function storage() { const data = new Map(); return { data, getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v) }; }
test('associations survive reload, new Bluetooth handles and multiple pendants; browser installations stay separate', () => {
  const local = storage(); let seq = 0, time = 'first';
  const registry = () => new devices.Registry(local, () => 'id-' + ++seq, () => time);
  const first = registry().associate(A, {id:'handle-a',name:'dk-pendant'});
  time = 'later';
  const again = registry().associate(A, {id:'handle-a-new',name:'dk-pendant'});
  assert.equal(first.associationId, again.associationId); assert.equal(first.installationId, again.installationId);
  assert.equal(again.firstConnectedAt, 'first'); assert.equal(again.lastConnectedAt, 'later');
  assert.deepEqual(again.bluetoothIds, ['handle-a','handle-a-new']);
  const other = registry().associate(B, {id:'handle-b'});
  assert.notEqual(first.associationId, other.associationId); assert.equal(registry().load().devices.length, 2);
  assert.throws(() => registry().associate(B, {id:'handle-a'}), e => e.code === 'DEVICE_ID_CHANGED');
  assert.equal(registry().load().devices[0].deviceId, A);
  const fresh = new devices.Registry(storage()).associate(A, {id:'handle-a'});
  assert.notEqual(fresh.installationId, first.installationId);
  local.data.clear(); assert.equal(registry().load().devices.length, 0);
});
test('invalid IDs and corrupt/blocked storage never claim a saved association', () => {
  for (const id of ['SYNAP-000000000000','SYNAP-FFFFFFFFFFFF','SYNAP-aabbccddeeff', A+'\0','other']) {
    assert.throws(() => devices.decode(value(id)));
  }
  assert.equal(devices.decode(value(A)), A);
  const local = storage(); local.setItem(devices.KEY, '{bad');
  assert.throws(() => new devices.Registry(local).associate(A, {id:'a'}));
  const blocked = storage(); blocked.setItem = () => {throw Error('quota');};
  assert.throws(() => new devices.Registry(blocked).associate(A, {id:'a'}), /quota/);
});
test('GATT identity read supports old firmware but rejects malformed data, read failure and stale connections', async () => {
  const queue = f => f();
  const service = {getCharacteristic: async uuid => {assert.equal(uuid, devices.UUID); return {readValue: async () => value(A)};}};
  assert.equal(await devices.read(service,queue,()=>{}), A);
  assert.equal(await devices.read({getCharacteristic:async()=>{throw Object.assign(Error(),{name:'NotFoundError'});}},queue,()=>{}),null);
  await assert.rejects(devices.read(service,queue,()=>{throw Error('stale');}), /stale/);
  await assert.rejects(devices.read({getCharacteristic:async()=>({readValue:async()=>{throw Error('link lost');}})},queue,()=>{}), /link lost/);
});

const app = fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const connectSource = app.slice(app.indexOf('  async function connectPendant('), app.indexOf('  async function disconnectPendant('));
const rememberSource = app.slice(app.indexOf('  function rememberDeviceAssociation('), app.indexOf('  function renderDeviceSetup('));
async function connect({id=A, local=storage(), stale=false, mismatch=false}={}) {
  const characteristic = {addEventListener(){},startNotifications:async()=>{}};
  const device={id:'browser-id',name:'dk-pendant',gatt:{connected:false,
    async connect(){this.connected=true;return this;},disconnect(){this.connected=false;},
    async getPrimaryService(){return {getCharacteristic:async uuid=>{
      if(uuid!==devices.UUID)return characteristic;
      if(id===null)throw Object.assign(Error('old firmware'),{name:'NotFoundError'});
      return {readValue:async()=>{if(stale)c.connectionEpoch++;return value(id);}};
    }};}}};
  const c={console,globalThis:{SynapDevices:devices},checkFirmwareRelease:null,connectInProgress:false,finalizing:false,
    needsDeviceSelection:false,bluetoothDevice:device,manualDisconnect:false,connectionEpoch:0,gattServer:null,
    recordingReconnectPending:false,
    navigator:{bluetooth:{}},SERVICE_UUID:'service',AUDIO_CHAR_UUID:'audio',CONTROL_CHAR_UUID:'control',CMD_STOP:0,CMD_GET_STATUS:2,
    DEVICE_STATE:{CONNECTED_IDLE:1,STREAMING:2,ERROR:3},deviceStatus:{state:1,error:0},deviceAssociation:null,deviceIdentityMessage:'',
    clearReconnectTimer(){},setReconnectCapability(){},setAppState(s){c.state=s;},log(){},toast(){},
    cleanupCharacteristics(){c.connectionEpoch++;c.deviceAssociation=null;},attachBluetoothDevice(d){c.bluetoothDevice=d;},
    withTimeout:p=>p,isGattConnected:()=>Boolean(c.bluetoothDevice?.gatt.connected),queueGattOperation:f=>f(),
    handleAudioNotification(){},handleStatusNotification(){},delay:async()=>{},writeCommand:async()=>{},readControlStatus:async()=>{},
    reconnectAttempts:0,localStorage:local,friendlyError:e=>e.message,scheduleAutoReconnect(){}};
  if(mismatch)new devices.Registry(local).associate(B,{id:device.id});
  vm.createContext(c);vm.runInContext(rememberSource+connectSource,c);await c.connectPendant();return c;
}
test('actual connect handler enrolls only an acknowledged connection; missing or failed identity is never marked complete', async () => {
  let c=await connect();assert.equal(c.state,'idle');assert.equal(c.deviceAssociation.deviceId,A);assert.match(c.deviceIdentityMessage,/Connected/);
  c=await connect({id:null});assert.equal(c.state,'idle');assert.equal(c.deviceAssociation,null);assert.match(c.deviceIdentityMessage,/no permanent/);
  c=await connect({id:'bad'});assert.equal(c.state,'idle');assert.equal(c.deviceAssociation,null);assert.match(c.deviceIdentityMessage,/could not be read/);
  const local=storage();c=await connect({local,stale:true});assert.equal(c.state,'disconnected');assert.equal(local.getItem(devices.KEY),null);
  c=await connect({mismatch:true});assert.equal(c.state,'disconnected');assert.equal(c.deviceAssociation,null);
  const blocked=storage();blocked.setItem=()=>{throw Error('blocked');};
  c=await connect({local:blocked});assert.equal(c.state,'idle');assert.equal(c.deviceAssociation.deviceId,A);assert.equal(c.deviceAssociation.associationId,undefined);assert.match(c.deviceIdentityMessage,/could not be saved/);
});
test('recordings snapshot device association without storing update credentials', async () => {
  require('../audio-store.js'); const store=new globalThis.DKAudioStore();let saved;
  store.atomic=async(names,action)=>action({recordings:{add:r=>saved=r}});
  await store.begin('first',{deviceId:A,associationId:'association',installationId:'installation',ownerKey:'must not persist'});
  assert.equal(saved.deviceId,A);assert.equal(saved.deviceAssociationId,'association');assert.equal(saved.pwaInstallationId,'installation');assert(!('ownerKey' in saved));
  await store.begin('legacy');assert.equal(saved.deviceId,null);assert.equal(saved.deviceAssociationId,null);
});