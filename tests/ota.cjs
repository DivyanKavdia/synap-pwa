// Protocol 3 uses a public target ID, never an owner key or signature.
const assert=require('node:assert/strict'),cryptoNode=require('node:crypto');
const ota=require('../ota.js'),{Client,decode,validateImage}=ota;
const ID='SYNAP-AABBCCDDEEFF',OTHER='SYNAP-112233445566';
function image(size=512) {
  const bytes=new Uint8Array(size);bytes[0]=0xE9;bytes[12]=9;
  new DataView(bytes.buffer).setUint32(32,0xABCD5432,true);
  bytes.set(new TextEncoder().encode('SYNAP-ESP32S3-OTA-ID-V3'),40);
  return {bytes,size,arrayBuffer:async()=>bytes.buffer};
}
function mock(options={}) {
  let connected=true,listener=null,deviceId=ID;
  const state={state:options.state??1,error:0,session:0,offset:0,capacity:2048,maxData:options.maxData??173};
  const chunks=[],commands=[],progress=[];let hash=null,length=0;
  if(options.resume) {
    const saved=image();state.state=3;state.session=55;state.offset=173;
    length=saved.size;hash=new Uint8Array(cryptoNode.createHash('sha256').update(saved.bytes).digest());
    chunks.push(saved.bytes.slice(0,173));
  }
  function status() {
    const b=new Uint8Array(20),v=new DataView(b.buffer);b[0]=0xD7;b[1]=options.protocol??3;b[2]=state.state;b[3]=state.error;
    v.setUint32(4,state.session,true);v.setUint32(8,state.offset,true);v.setUint32(12,state.capacity,true);
    v.setUint16(16,state.maxData,true);v.setUint16(18,1004,true);return v;
  }
  const characteristic={addEventListener:(t,f)=>listener=f,removeEventListener:()=>listener=null,
    startNotifications:async()=>{},readValue:async()=>status()};
  const writePacket=async bytes=>{
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),cmd=bytes[0];commands.push(cmd);
    if(cmd===1) {
      assert.equal(bytes.length,59);assert.equal(new TextDecoder().decode(bytes.subarray(41)),ID);
      state.session=v.getUint32(1,true);state.offset=0;state.error=0;chunks.length=0;
      if(options.deviceMismatch){state.state=1;state.error=12;listener?.({target:{value:status()}});return;}
      length=v.getUint32(5,true);hash=bytes.slice(9,41);state.state=3;
    }
    if(cmd===2) {
      if(options.queuedFlash && v.getUint32(5,true)!==state.offset) {
        state.error=4;state.state=6;listener?.({target:{value:status()}});return;
      }
      assert.equal(v.getUint32(5,true),state.offset,'strict FIFO offset');
      chunks.push(bytes.slice(9));state.offset+=bytes.length-9;
      if(options.drop){connected=false;client.reset();throw Error('link lost');}
      if(options.chunkFailure){state.error=5;state.state=6;}
      if(options.cancel)client.cancel();
    }
    if(cmd===6) {
      assert.equal(v.getUint32(1,true),state.session);assert.equal(v.getUint32(5,true),length);
      assert.equal(new TextDecoder().decode(bytes.subarray(41)),ID);state.error=0;
    }
    if(cmd===3) {
      assert.equal(state.offset,length);
      assert.equal(Buffer.from(hash).toString('hex'),cryptoNode.createHash('sha256').update(Buffer.concat(chunks)).digest('hex'));
      state.state=options.hashFailure?6:4;state.error=options.hashFailure?7:0;
    }
    if(cmd===4){assert.equal(state.state,4,'commit only after validation');state.state=5;
      if(options.commitDrop){connected=false;client.reset();throw Error('reboot');}}
    if(cmd===5&&[3,4].includes(state.state)){state.state=6;state.error=10;}
    if(listener&&!options.noNotifications)listener({target:{value:status()}});
  };
  // Bluetooth acceptance can precede the control task writing flash. A lost
  // write-without-response packet must not cause later offsets to be sent.
  const transport={pending:0,peak:0,unacknowledged:0};
  let flashQueue=Promise.resolve();
  async function deliver(bytes, response) {
    if(bytes[0]!==2 || !options.queuedFlash) return writePacket(bytes);
    if(!response && ++transport.unacknowledged===2 && options.dropUnacknowledged) return;
    ++transport.pending;transport.peak=Math.max(transport.peak,transport.pending);
    const copy=bytes.slice();
    flashQueue=flashQueue.then(async()=>{
      await new Promise(resolve=>setTimeout(resolve,20));
      --transport.pending;await writePacket(copy);
    });
    // Return as soon as Bluetooth accepts the packet, before flash/notification.
  }
  const write={properties:{writeWithoutResponse:!!options.fast},writeValueWithResponse:bytes=>deliver(bytes,true),
    writeValueWithoutResponse:bytes=>deliver(bytes,false)};
  const client=new Client({connected:()=>connected,queue:async f=>f(),progress:(...p)=>progress.push(p),
    getService:async()=>({getCharacteristic:async uuid=>{
      if(options.missing)throw Object.assign(Error('missing'),{name:'NotFoundError'});
      if(uuid.includes('12348'))return write;
      if(uuid.includes('1234c'))return{readValue:async()=>{
        if(options.disconnectIdentity){connected=false;client.reset();}
        return new TextEncoder().encode(options.badIdentity?'bad':deviceId);
      }};
      assert(uuid.includes('12349'),'no challenge or owner-key characteristic is read');return characteristic;
    }})});
  return{client,state,commands,chunks,progress,transport,setId:id=>deviceId=id,disconnect:()=>{connected=false;client.reset();}};
}
(async()=>{
  assert.throws(()=>decode(new DataView(new ArrayBuffer(2))),/protocol/);
  assert.equal(ota.authorize,undefined);assert.equal(ota.importOwnerKey,undefined);
  validateImage(image().bytes,2048);
  for(const index of [0,12,32,40]){const f=image();f.bytes[index]^=1;assert.throws(()=>validateImage(f.bytes,2048));}
  assert.throws(()=>validateImage(image().bytes,100),/slot/);
  let t=mock();const info=await t.client.check();assert.equal(info.deviceId,ID);assert.equal(info.protocol,3);
  const result=await t.client.update(image(),ID,'esp32s3-fh4r2-qspi-4m');assert.equal(result.committed,true);assert.equal(t.client.busy,false);
  assert.deepEqual(t.commands,[1,2,2,2,3,4]);assert.equal(Buffer.concat(t.chunks).length,512);
  const transferProgress=t.progress.find(p=>p[3]?.phase==='transfer');
  assert(transferProgress,'transfer progress exposes structured telemetry');
  assert.equal(transferProgress[3].total,512);assert(Number.isInteger(transferProgress[3].percent));
  assert.equal(t.progress.at(-1)[2],true,'cancel disabled at commit');
  t=mock({resume:true,fast:true});await t.client.check();assert((await t.client.update(image(),ID)).committed);
  assert.equal(t.commands[0],6,'reconnect resumes rather than sends BEGIN');assert.equal(Buffer.concat(t.chunks).length,512);
  t=mock({fast:true,queuedFlash:true,dropUnacknowledged:true,maxData:503});
  await t.client.check();assert((await t.client.update(image(2048),ID)).committed);
  assert.equal(t.transport.unacknowledged,0,'data uses Bluetooth write responses');
  assert.equal(t.transport.peak,1,'wait for written-byte ACK before next chunk');
  assert.equal(Buffer.concat(t.chunks).length,2048);
  t=mock({resume:true,fast:true,queuedFlash:true});await t.client.check();
  assert((await t.client.update(image(),ID)).committed);
  assert.equal(t.commands[0],6);assert.equal(t.transport.peak,1);
  for(const protocol of [1,2]){t=mock({protocol});await t.client.check();await assert.rejects(t.client.update(image(),ID),/USB once/);assert.equal(t.commands.length,0);}
  t=mock({missing:true});await assert.rejects(t.client.check(),/USB once/);
  for(const options of [{drop:true},{chunkFailure:true},{hashFailure:true},{cancel:true},{deviceMismatch:true}]){
    t=mock(options);await t.client.check();await assert.rejects(t.client.update(image(),ID));
    assert(!t.commands.includes(4),'failure never commits');assert.equal(t.client.busy,false);
    if(!options.drop)assert(t.commands.includes(5),'best-effort cancellation');
  }
  t=mock({commitDrop:true});await t.client.check();await assert.rejects(t.client.update(image(),ID),/confirmation is incomplete/);assert(!t.commands.includes(5));
  t=mock({noNotifications:true});await t.client.check();assert((await t.client.update(image(80),ID)).committed,'read fallback');
  t=mock();await t.client.check();const bad=image();bad.bytes[0]=0;
  await assert.rejects(t.client.update(bad,ID),/application/);assert.equal(t.commands.length,0);
  t=mock();await t.client.check();
  await assert.rejects(t.client.update(image(),ID,'esp32c3-supermini-4m'),/selected synap hardware target/);
  assert.equal(t.commands.length,0,'cross-target image is rejected before BEGIN');
  for(const id of [undefined,'','bad',OTHER]){
    t=mock();await t.client.check();await assert.rejects(t.client.update(image(),id));assert.equal(t.commands.length,0);
  }
  t=mock();await t.client.check();t.setId(OTHER);await assert.rejects(t.client.update(image(),ID),/mismatch/);assert.equal(t.commands.length,0);
  for(const options of [{badIdentity:true},{disconnectIdentity:true}]){t=mock(options);await assert.rejects(t.client.check());assert.equal(t.commands.length,0);}
  for(const options of [{state:0},{state:5},{maxData:63},{maxData:504}]){t=mock(options);await t.client.check();await assert.rejects(t.client.update(image(),ID));assert.equal(t.commands.length,0);}
  t=mock();await t.client.check();t.disconnect();await assert.rejects(t.client.update(image(),ID),/interrupted/);
  console.log('PASS: device-ID protocol, confirmed chunk transfer, reconnect resume, SHA-256, failure/cancel/reboot and read fallback.');
})().catch(error=>{console.error(error);process.exitCode=1;});
