/* Module identity comes from firmware, never from the Bluetooth display name. */
(function(root) {
  'use strict';
  const UUID='4fa12350-0000-1000-8000-00805f9b34fb';
  const IDENTITY='4fa1234b-0000-1000-8000-00805f9b34fb';
  const COMMAND='4fa12351-0000-1000-8000-00805f9b34fb';
  const STATUS='4fa12352-0000-1000-8000-00805f9b34fb';
  const PATH='4fa12353-0000-1000-8000-00805f9b34fb';
  const FLAGS=Object.freeze({audio:1,camera:2,sd:4,settings:8,touch:16,battery:32,standby:64,video:128,sdAudio:256,photo:512});
  const PROFILES=Object.freeze({
    1:Object.freeze({id:1,target:'esp32s3-fh4r2-qspi-4m',name:'synap S3',board:'ESP32-S3 SuperMini'}),
    2:Object.freeze({id:2,target:'esp32c3-supermini-4m',name:'synap C3',board:'ESP32-C3 SuperMini'}),
    3:Object.freeze({id:3,target:'xiao-esp32s3-sense-8m',name:'Chakshu',board:'XIAO ESP32S3 Sense'})
  });
  const ERRORS=['','Finish the current recording or firmware update first.','Unsupported hardware check.',
    'SD card is unavailable. Check the card and retry.','Camera did not initialize. Check the Sense board connection.',
    'Microphone did not initialize.','SD card needs at least 4 MiB free.','Could not finish writing to the SD card.',
    'Capture failed. Retry the hardware check.'];
  function decode(value) {
    if (!value || value.byteLength!==20 || value.getUint8(0)!==0xC7 || value.getUint8(1)!==1 ||
        value.getUint8(3)!==1) throw Error('Unsupported module capability descriptor.');
    const profile=PROFILES[value.getUint8(2)];
    if (!profile) throw Error('This Synap module is not recognized by this app.');
    const supported=value.getUint16(4,true),ready=value.getUint16(6,true);
    if (ready&~supported) throw Error('Invalid module readiness flags.');
    return Object.freeze({...profile,supported,ready,sensor:value.getUint16(8,true),
      sampleRate:value.getUint16(10,true),flashMiB:value.getUint8(12),psramMiB:value.getUint8(13),legacy:false});
  }
  function legacy(identity) {
    const match=/^SYNAP-FW:([^:]+):(?:synap-os1-build\d+|\d+\.\d+\.\d+):\d+$/.exec(identity);
    const profile=match&&Object.values(PROFILES).find(p=>p.target===match[1]);
    // Chakshu needs the capability protocol; do not expose controls on a name/identity guess.
    return profile&&profile.id!==3?Object.freeze({...profile,supported:121,ready:0,legacy:true}):null;
  }
  function decodeStatus(value) {
    if (!value || value.byteLength!==20 || value.getUint8(0)!==0xC9 || value.getUint8(1)!==1 ||
        value.getUint8(2)>4 || value.getUint8(4)>3 || value.getUint8(5)>8 || value.getUint8(7)>100)
      throw Error('Invalid Chakshu hardware-check status.');
    const result={operation:value.getUint8(2),id:value.getUint8(3),state:value.getUint8(4),
      error:value.getUint8(5),ready:value.getUint8(6),progress:value.getUint8(7),
      totalMiB:value.getUint32(8,true),freeMiB:value.getUint32(12,true),bytes:value.getUint32(16,true)};
    if (result.freeMiB>result.totalMiB) throw Error('Invalid SD capacity report.');
    return Object.freeze(result);
  }
  class Client {
    constructor(context,changed=()=>{}) {
      this.context=context;this.changed=changed;this.module=null;this.status=null;this.path='';
      this.closed=false;this.pending=false;this.commandPending=false;this.characteristics={};
      this.nextId=1;this.pathKey='';this.error='';this.available=false;
    }
    get busy() { return this.commandPending || this.status?.state===1; }
    close() { this.closed=true;this.characteristics={}; }
    async characteristic(uuid) {
      if (!this.characteristics[uuid]) this.characteristics[uuid]=await this.context.queue(
        ()=>this.context.service.getCharacteristic(uuid),'Find module characteristic');
      this.ensure();return this.characteristics[uuid];
    }
    ensure() { if (this.closed) throw Error('Module connection changed.'); }
    async read(uuid) {
      const characteristic=await this.characteristic(uuid);
      const value=await this.context.queue(()=>characteristic.readValue(),'Read module status');
      this.ensure();return value;
    }
    async identify() {
      let value;
      try { value=await this.read(UUID); }
      catch(error) {
        if(error.name!=='NotFoundError')throw error;
        this.module=legacy(new TextDecoder('utf-8',{fatal:true}).decode(await this.read(IDENTITY)));
        this.available=true;return;
      }
      this.module=decode(value);this.available=true;
    }
    async updateStatus() {
      this.status=decodeStatus(await this.read(STATUS));
      this.nextId=(this.status.id%255)+1;
      if (this.status.state!==1) {
        const key=this.status.id+':'+this.status.operation;
        if (this.pathKey!==key) {
          const path=new TextDecoder('utf-8',{fatal:true}).decode(await this.read(PATH));
          if(path&&!/^\/synap\/[a-f0-9]{8}-[a-f0-9]{8}\.(jpg|wav|mjpeg)$/.test(path))throw Error('Invalid SD file path.');
          this.path=path;this.pathKey=key;
        }
      } else this.path='';
    }
    async refresh() {
      if (this.pending || this.closed || this.context.canUse?.()===false) return false;
      this.pending=true;
      try {
        await this.identify();
        if(this.module?.id===3)await this.updateStatus();
        this.error='';return true;
      } catch(error) {
        if(this.closed)return false;
        if(error.code==='OPTIONAL_GATT_DEFERRED'||error.name==='AbortError')return false;
        this.error=error.message;return false;
      } finally { this.pending=false;if(!this.closed)this.changed(this); }
    }
    async run(operation) {
      if(![1,2,3,4].includes(operation)||this.module?.id!==3)throw Error('Connect Chakshu first.');
      if(this.pending || this.busy)throw Error('Wait for the current hardware check.');
      if(this.context.canUse?.()===false)throw Error(ERRORS[1]);
      const flags=this.module.supported;
      const needed={1:0,2:FLAGS.photo|FLAGS.sd,3:FLAGS.sdAudio,4:FLAGS.video|FLAGS.sd}[operation];
      if((flags&needed)!==needed)throw Error('This module does not support that hardware check.');
      this.pending=true;this.commandPending=true;this.error='';this.path='';this.changed(this);
      try {
        await this.updateStatus();
        if(this.status.state===1)throw Error('A hardware check is already running on Chakshu.');
        const id=this.nextId;
        const characteristic=await this.characteristic(COMMAND);
        await this.context.queue(()=>characteristic.writeValueWithResponse(new Uint8Array([0xC8,1,operation,id])),'Start Chakshu hardware check');
        this.ensure();
        // Keep the UI locked until a read confirms acceptance or failure.
        this.status={...this.status,operation,id,state:1,progress:0,error:0,bytes:0};
        this.pathKey='';this.error='';
      } catch(error) { this.error=error.message;throw error; }
      finally { this.commandPending=false;this.pending=false;if(!this.closed)this.changed(this); }
    }
  }
  let client=null,timer=null;
  const notify=()=>root.dispatchEvent?.(new CustomEvent('synap-module-changed'));
  function attach(context) {
    client?.close();client=new Client(context,notify);notify();
    schedule(250);
  }
  function schedule(delay=client?.busy?750:!client?.available?1000:15000) {
    if(timer)root.clearTimeout(timer);
    timer=root.setTimeout(async()=>{
      timer=null;
      if(!client)return;
      await client.refresh();
      if(client)schedule();
    },delay);
  }
  root.addEventListener?.('synap-gatt-service-ready',event=>attach(event.detail));
  root.addEventListener?.('synap-gatt-disconnected',()=>{
    client?.close();client=null;if(timer)root.clearTimeout(timer);timer=null;notify();
  });
  const api={UUID,FLAGS,PROFILES,decode,legacy,decodeStatus,Client,ERRORS,
    get client(){return client;},get busy(){return Boolean(client?.busy);},
    async refresh(){return client?.refresh();},
    async run(operation){if(!client)throw Error('Connect Chakshu first.');const result=await client.run(operation);schedule(250);return result;}
  };
  root.SynapModules=api;
  if(root.SynapDevices?.connection)attach(root.SynapDevices.connection);
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
