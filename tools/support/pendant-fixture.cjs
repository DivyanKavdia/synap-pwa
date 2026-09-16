'use strict';
module.exports = function pendantFixture() {
  if (!localStorage.getItem('dk-pendant-auto-reconnect'))
    localStorage.setItem('dk-pendant-auto-reconnect', 'off');
  localStorage.setItem(
    'dk-pendant-settings',
    JSON.stringify({ autoProcess: false, wakeLock: false }),
  );
  const orphanTransport = location.search.includes('orphan-transport');
  const buffered = location.search.includes('buffered') || orphanTransport;
  const connectedReplay = location.search.includes('background');
  const recoveryCapacity = connectedReplay && location.search.includes('c3') ? 25 : 600;
  const chakshu=location.search.includes('chakshu');
  const inventoryFixture=location.search.includes('inventory');
  const chakshu1227=chakshu&&location.search.includes('chakshu1227');
  const legacyPathBuffer=new Uint8Array(64);
  const ota = location.search.includes('ota');
  const target = chakshu ? 'xiao-esp32s3-sense-8m' : location.search.includes('c3') ? 'esp32c3-supermini-4m' : 'esp32s3-fh4r2-qspi-4m';
  let firmwareBuild = chakshu1227 ? 1227 : 1200,
    otaState = 1,
    otaSession = 0,
    otaOffset = 0,
    otaBegins = 0,
    otaCommits = 0,
    otaHold = false;
  const otaStatus = () => {
    const v = new DataView(new ArrayBuffer(20));
    v.setUint8(0, 0xd7);
    v.setUint8(1, 3);
    v.setUint8(2, otaState);
    v.setUint32(4, otaSession, true);
    v.setUint32(8, otaOffset, true);
    v.setUint32(12, 0x140000, true);
    v.setUint16(16, 503, true);
    v.setUint16(18, firmwareBuild, true);
    return v;
  };
  const mediaCommands=[];let sdInserted=true,wifiRunning=false;
  const wifiInfo=()=>wifiRunning?{active:true,ssid:'Chakshu-AB12',password:'a'.repeat(32),url:'http://192.168.4.1/?key='+ 'b'.repeat(32)}:{active:false};
  let transferReply=new DataView(new ArrayBuffer(16)),transferBytes=new Uint8Array(),offlineRecording=false;
  let delayCameraReply=false,uninitializedMediaReads=0,cameraReadDelay=0;
  function cameraJPEG(){const c=document.createElement('canvas');c.width=160;c.height=120;const ctx=c.getContext('2d');ctx.fillStyle='#776ac4';ctx.fillRect(0,0,160,120);ctx.fillStyle='#fff';ctx.fillRect(20,20,80,50);return Uint8Array.from(atob(c.toDataURL('image/jpeg').split(',')[1]),x=>x.charCodeAt(0));}
  function transferCommand(bytes){const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),op=bytes[1],id=v.getUint32(2,true),offset=v.getUint32(6,true);let payload=new Uint8Array(),total=0;
    mediaCommands.push(op);
    if(op===1||op===13)transferBytes=cameraJPEG();
    if(op===7)transferBytes=new TextEncoder().encode(JSON.stringify([{path:'/synap/abcdef01-00000001.jpg',bytes:1200}]));
    if(op===3)transferBytes=cameraJPEG();
    if(op===5)offlineRecording=true;if(op===6)offlineRecording=false;
    if(op===14)sdAvailable=sdInserted;
    if(op===20)wifiRunning=true;if(op===22)wifiRunning=false;
    if(op===12){
      let end=offset;
      const emit=(kind,data)=>{const c=chars.get(uuid('5a')),v=new DataView(new ArrayBuffer(16+data.length));
        [0xCC,1,kind,0].forEach((n,i)=>v.setUint8(i,n));v.setUint32(4,id,true);v.setUint32(8,transferBytes.length,true);
        v.setUint32(12,kind===2?end:end-data.length,true);new Uint8Array(v.buffer).set(data,16);c.value=v;c.dispatchEvent(new Event('characteristicvaluechanged'));};
      for(let n=0;n<8&&end<transferBytes.length;n++){const data=transferBytes.slice(end,end+480);end+=data.length;emit(1,data);}
      emit(2,new Uint8Array());return;
    }
    if(op===2||op===4)payload=transferBytes.slice(offset,offset+480);
    total=transferBytes.length;
    if(op===9)payload=new TextEncoder().encode(JSON.stringify({active:offlineRecording,state:offlineRecording?1:2,error:0,progress:20,path:'/synap/abcdef01-00000001.mjpeg',audioMs:2000,frames:18,droppedFrames:2}));
    if([20,21,22].includes(op))payload=new TextEncoder().encode(JSON.stringify(wifiInfo()));
    if(op===15)payload=new TextEncoder().encode('/synap/abcdef01-00000001.jpg');
    transferReply=new DataView(new ArrayBuffer(16+payload.length));[0xCB,1,1,0].forEach((n,i)=>transferReply.setUint8(i,n));transferReply.setUint32(4,id,true);transferReply.setUint32(8,total,true);transferReply.setUint32(12,offset,true);new Uint8Array(transferReply.buffer).set(payload,16);
  }
  let voiceSequence=0, voiceAction=0, voiceEnabled=true, voiceLease=0, voiceResult=0,emptyVoiceRead=false;
  let modelState=0,modelOffset=0,modelSession=0,modelBegins=0,modelFailure=0;
  function modelStatus(){const embedded=location.search.includes('flash-model'),v=new DataView(new ArrayBuffer(20));[0xCE,1,embedded?3:modelState,0].forEach((n,i)=>v.setUint8(i,n));v.setUint32(4,modelSession,true);v.setUint32(8,embedded?2177224:modelOffset,true);v.setUint32(12,2177224,true);v.setUint16(16,480,true);v.setUint8(18,sdAvailable?1:0);v.setUint8(19,embedded?2:1);return v;}
  function voiceStatus(){const v=new DataView(new ArrayBuffer(20));[0xCD,1,voiceEnabled?1:5,voiceEnabled?1:0].forEach((x,i)=>v.setUint8(i,x));v.setUint32(4,voiceSequence,true);v.setUint8(8,voiceAction);v.setUint8(9,voiceResult);return v;}
  function emitVoice(){const c=chars.get(uuid('57'));c.value=voiceStatus();c.dispatchEvent(new Event('characteristicvaluechanged'));}
  let mediaOperation=0,mediaId=0,mediaState=0,mediaError=0,sdAvailable=!location.search.includes('missing-sd'),mediaWrites=0;
  function moduleDescriptor() {
    const v=new DataView(new ArrayBuffer(20));
    [0xC7,1,3,1].forEach((x,i)=>v.setUint8(i,x));
    v.setUint16(4,911,true);v.setUint16(6,sdAvailable?911:651,true);
    v.setUint16(8,0x3660,true);v.setUint16(10,16000,true);v.setUint8(12,8);v.setUint8(13,8);v.setUint8(14,location.search.includes('chakshu-media')?1:0);v.setUint8(15,location.search.includes('voice')?1:0);v.setUint8(16,location.search.includes('sd-fast')?15:0);return v;
  }
  function mediaStatus() {
    const v=new DataView(new ArrayBuffer(20));
    [0xC9,1,mediaOperation,mediaId,mediaState,mediaError,sdAvailable?7:3,mediaState===2?100:0].forEach((x,i)=>v.setUint8(i,x));
    v.setUint32(8,sdAvailable?1900:0,true);v.setUint32(12,sdAvailable?1800:0,true);
    v.setUint32(16,mediaState===2&&mediaOperation!==1?(mediaOperation===3?320000:12000):0,true);return v;
  }
  function mediaPath() {
    return mediaState===2&&mediaOperation!==1?'/synap/12345678-00000001.'+({2:'jpg',3:'wav',4:'mjpeg'}[mediaOperation]):'';
  }
  let armed = orphanTransport,
    waiting = orphanTransport,
    finishing = false,
    owner = [],
    buffer = [],
    sendTimer = null, sendIntervalMs = 15;
  let retained = [], replayAck = 0, replayCommands = 0, blockAudio = false, audioSubscriptions = 0, restoreOnSubscribe = false;
  let stopDisconnect = null,
    echoStop = false,
    rejectStopResponse = false,
    rejectStops = 0,
    responseStopAttempts = 0,
    stopWrites = 0,
    pauseReplay = false,
    idleOnReconnect = false,
    invalidRecoveryReads = 0;
  const recoveryStatus = () => {
    const v = new DataView(new ArrayBuffer(16));
    v.setUint8(0, 0x52);
    v.setUint8(1, 1);
    v.setUint8(2, 1 + (armed ? 2 : 0) + (waiting ? 4 : 0) + (finishing ? 8 : 0) + (connectedReplay ? 16 : 0));
    v.setUint8(3, replayAck);
    v.setUint16(4, recoveryCapacity, true);
    let hash = 2166136261;
    for (const byte of owner) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    v.setUint32(12, hash, true);
    return v;
  };
  let state = orphanTransport ? 2 : 1,
    sequence = 0,
    audioTimer = null,
    inFlight = 0,
    maxInFlight = 0,
    present = true,
    watching = false;
  let visibility = 'visible',
    hideOnConnect = false,
    appDisconnects = 0,
    statusReads = 0,
    holdRead = false,
    releaseRead = null,
    readError = null,
    holdStop = false,
    releaseStop = null;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  function setVisibility(value) {
    visibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }
  const count = (key) => Number(sessionStorage.getItem(key) || 0);
  const increment = (key) => sessionStorage.setItem(key, String(count(key) + 1));
  const uuid = (n) => '4fa123' + n + '-0000-1000-8000-00805f9b34fb';
  const status = () => {
    const v = new DataView(new ArrayBuffer(16));
    v.setUint8(0, 0x5a);
    v.setUint8(1, 2);
    v.setUint8(2, state);
    // Firmware resets transport metadata on a new link while the previous
    // buffered take waits for its owner to RESUME, or for STOP/expiry.
    v.setUint16(4, waiting ? 23 : 512, true);
    v.setUint16(6, waiting ? 20 : 509, true);
    v.setUint8(8, waiting ? 0 : 4);
    v.setUint8(9, 8);
    v.setUint16(10, 16000, true);
    v.setUint16(12, 800, true);
    v.setUint16(14, waiting ? 0 : 400, true);
    return v;
  };
  async function operation(fn) {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight > 1) throw Error('Overlapping GATT requests');
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await fn();
    } finally {
      inFlight--;
    }
  }
  class Characteristic extends EventTarget {
    constructor(id) {
      super();
      this.id = id;
      this.properties = { write: true, read: true, notify: true, writeWithoutResponse: id === uuid('47') };
      this.value = null;
    }
    startNotifications() {
      return operation(() => {if(this.id===uuid('46')){audioSubscriptions++;if(restoreOnSubscribe){blockAudio=false;restoreOnSubscribe=false;}}return this;});
    }
    readValue() {
      return operation(async () => {
        if (this.id === uuid('50')) return moduleDescriptor();
        if (this.id === uuid('55')) {
          if(cameraReadDelay){const ms=cameraReadDelay;cameraReadDelay=0;await new Promise(resolve=>setTimeout(resolve,ms));}
          if(transferReply.getUint8(0)===0)uninitializedMediaReads++;return transferReply;
        }
        if (this.id === uuid('56')) return emptyVoiceRead?new DataView(new ArrayBuffer(0)):voiceStatus();
        if (this.id === uuid('59')) return modelStatus();
        if (this.id === uuid('52')) return mediaStatus();
        if (this.id === uuid('53')) {
          const path=new TextEncoder().encode(mediaPath());
          if(!chakshu1227)return new DataView(path.buffer);
          legacyPathBuffer.set(path);legacyPathBuffer[path.length]=0;
          return new DataView(legacyPathBuffer.slice().buffer);
        }
        if (this.id === uuid('49')) return otaStatus();
        if (this.id === uuid('4b'))
          return new DataView(
            new TextEncoder().encode('SYNAP-FW:' + target + ':1.0.0:' + firmwareBuild).buffer,
          );
        if (this.id === uuid('4f')) {
          if (invalidRecoveryReads > 0) {
            invalidRecoveryReads--;
            return new DataView(new ArrayBuffer(4));
          }
          return recoveryStatus();
        }
        if (this.id === uuid('47')) {
          statusReads++;
          if (holdRead) {
            holdRead = false;
            await new Promise((resolve) => {
              releaseRead = resolve;
            });
          }
          return echoStop && finishing && this.value?.byteLength === 2 ? this.value : status();
        }
        return this.id === uuid('4c')
          ? new DataView(new TextEncoder().encode('SYNAP-ABCDEF123456'+(chakshu1227?'\0':'')).buffer)
          : new DataView(new Uint8Array([0xe2, 1, 1, 0, 0x82, 4]).buffer);
      });
    }
    writeValueWithResponse(value) {
      return this.write(value, true);
    }
    write(value, withResponse) {
      return operation(async () => {
        if(this.id===uuid('58')){
          const v=new DataView(value.buffer,value.byteOffset,value.byteLength),op=value[0];
          if(op===1){modelBegins++;modelOffset=0;modelSession=v.getUint32(1,true);modelState=1;}
          if(op===2){
            if(modelFailure&&modelOffset>=modelFailure){modelFailure=0;loseLink();throw new DOMException('Model link lost','NetworkError');}
            if(v.getUint32(5,true)!==modelOffset)throw Error('Model offset mismatch');
            modelOffset+=value.length-9;
          }
          if(op===3){if(modelOffset!==2177224)throw Error('Incomplete model');modelState=3;}
          if(op===5)modelState=4;
          if(op===4)modelState=5;
          return;
        }
        if (this.id===uuid('56')) { if(value[2]===0||value[2]===1)voiceEnabled=value[2]===1;if(value[2]===2)voiceLease=Date.now();if(value[2]===3)voiceLease=0;return; }
        if (this.id===uuid('54')) {
          if(value[1]===1&&delayCameraReply){
            delayCameraReply=false;transferReply=new DataView(new ArrayBuffer(16));
            const request=value.slice();setTimeout(()=>transferCommand(request),150);
          }else transferCommand(value);
          return;
        }
        if (this.id===uuid('51')) {
          mediaWrites++;mediaOperation=value[2];mediaId=value[3];
          mediaError=state===2?1:!sdAvailable&&mediaOperation!==1?3:0;
          mediaState=mediaError?3:1;return;
        }
        if (this.id === uuid('47') && value[0] === 0 && holdStop) {
          holdStop = false;
          await new Promise(resolve => { releaseStop = resolve; });
        }
        if (this.id === uuid('48')) {
          const v = new DataView(value.buffer, value.byteOffset, value.byteLength),
            command = value[0];
          if (command === 1) {
            otaBegins++;
            otaSession = v.getUint32(1, true);
            otaOffset = 0;
            otaState = 3;
          }
          if (command === 2) {
            while (otaHold) await new Promise((resolve) => setTimeout(resolve, 10));
            if (v.getUint32(5, true) !== otaOffset) throw Error('Unexpected firmware offset');
            otaOffset += value.length - 9;
          }
          if (command === 3) otaState = 4;
          if (command === 4) {
            otaCommits++;
            otaState = 5;
            firmwareBuild = 1201;
            setTimeout(() => {
              otaState = 1;
              loseLink();
            }, 30);
          }
          if (command === 5) otaState = 6;
          const ack = chars.get(uuid('49'));
          ack.value = otaStatus();
          ack.dispatchEvent(new Event('characteristicvaluechanged'));
          return;
        }
        if (this.id === uuid('4f')) {
          if (value[0] === 1 && state === 1) {
            armed = true;
            owner = [...value.slice(1, 9)];
          }
          if (value[0] === 2 && waiting && owner.every((x, i) => x === value[i + 1])) {
            const last = value[9] + value[10] * 256,
              index = buffer.indexOf(last);
            buffer = buffer.slice(index < 0 ? 0 : index + 1);
            waiting = false;
            startSender();
          }
          if (value[0] === 3 && connectedReplay && armed && !waiting && !finishing && state === 2 && owner.every((x, i) => x === value[i + 1])) {
            const last = value[9] + value[10] * 256, index = retained.indexOf(last);
            buffer = retained.slice(index < 0 ? 0 : index + 1);
            replayAck = (replayAck + 1) & 255;
            replayCommands++;
            startSender();
          }
          return;
        }
        if (value[0] === 0) {
          if(withResponse)responseStopAttempts++;
          if(rejectStops>0){rejectStops--;throw undefined;}
          if (rejectStopResponse && withResponse) { rejectStopResponse=false;throw new DOMException('GATT Error Unknown.','NotSupportedError'); }
          stopWrites++;
        }
        if (buffered && value[0] === 0 && state === 2 && !waiting) {
          if (stopDisconnect === 'before') {
            stopDisconnect = null;
            setVisibility('hidden');
            loseLink();
            throw new DOMException('Link lost before STOP arrived', 'NetworkError');
          }
          clearInterval(audioTimer);
          finishing = true;
          if(echoStop)this.value=new DataView(value.slice().buffer);
          const recovery = chars.get(uuid('4f'));
          recovery.value = recoveryStatus();
          recovery.dispatchEvent(new Event('characteristicvaluechanged'));
          if (stopDisconnect === 'after') {
            stopDisconnect = null;
            setVisibility('hidden');
            loseLink();
            return;
          }
          startSender();
          return;
        }
        if (value[0] === 1) {
          increment('qa-starts');
          state = 2;
          sequence = 0;
          buffer = [];
          retained = [];
          finishing = false;
          waiting = false;
          clearInterval(sendTimer);
          sendTimer = null;
          clearInterval(audioTimer);
          audioTimer = setInterval(frame, 50);
        }
        if (value[0] === 0) {
          state = 1;
          waiting = false;
          finishing = false;
          buffer = [];
          clearInterval(audioTimer);
          clearInterval(sendTimer);
          sendTimer = null;
        }
        this.value = status();
        this.dispatchEvent(new Event('characteristicvaluechanged'));
      });
    }
    writeValueWithoutResponse(value) { return this.write(value, false); }
  }
  const audio = new Characteristic(uuid('46')),
    control = new Characteristic(uuid('47'));
  const chars = new Map([
    [uuid('46'), audio],
    [uuid('47'), control],
    [uuid('4c'), new Characteristic(uuid('4c'))],
    [uuid('4e'), new Characteristic(uuid('4e'))],
  ]);
  if(chakshu)for(const id of ['50','51','52','53','54','55','56','57','5a','4b'])chars.set(uuid(id),new Characteristic(uuid(id)));
  if(chakshu&&location.search.includes('model'))for(const id of ['58','59'])chars.set(uuid(id),new Characteristic(uuid(id)));
  if (buffered) chars.set(uuid('4f'), new Characteristic(uuid('4f')));
  if (ota) for (const id of ['48', '49', '4b']) chars.set(uuid(id), new Characteristic(uuid(id)));
  if (location.search.includes('minimal-pendant')) {
    for (const id of ['4c', '4e']) chars.delete(uuid(id));
  }
  for (const [id, characteristic] of chars) characteristic.uuid = id;
  let inventoryReads=0,missingProbes=0;
  let discoveryBusy = false;
  const discoveryDelays = new Map(), discoveries = [];
  if (location.search.includes('slow-startup'))
    for (const id of ['50', '4e', '48', '49']) discoveryDelays.set(uuid(id), 3200);
  const service = {
    getCharacteristic: (id) =>
      operation(async () => {
        discoveries.push({ id, at: performance.now() });
        if (discoveryDelays.has(id)) {
          const ms = discoveryDelays.get(id);
          discoveryDelays.delete(id);
          discoveryBusy = true;
          try { await new Promise(resolve => setTimeout(resolve, ms)); }
          finally { discoveryBusy = false; }
        }
        if (!chars.has(id)) {
          missingProbes++;
          // Emulate a native bridge that never completes discovery for an
          // unsupported extension. Core audio/control remain usable.
          if (inventoryFixture) await new Promise(() => {});
          throw new DOMException('No optional characteristic', 'NotFoundError');
        }
        return chars.get(id);
      }),
  };
  if (inventoryFixture) service.getCharacteristics = () => operation(() => {
    inventoryReads++;
    if (location.search.includes('inventory-reject')) return Promise.reject(2);
    if (location.search.includes('inventory-incomplete')) return [chars.get(uuid('46'))];
    if (location.search.includes('inventory-hang')) return new Promise((resolve, reject) => {
      device.addEventListener('gattserverdisconnected', () => reject(2), { once: true });
    });
    return [...chars.values()];
  });
  const device = new EventTarget();
  device.id = 'fixture-device';
  device.name = 'synap';
  function loseLink() {
    const wasConnected = device.gatt.connected;
    device.gatt.connected = false;
    if (buffered && armed && state === 2) {
      waiting = true;
      clearInterval(sendTimer);
    } else clearInterval(audioTimer);
    if (wasConnected) device.dispatchEvent(new Event('gattserverdisconnected'));
  }
  device.gatt = {
    connected: sessionStorage.getItem('qa-retain-link') === '1',
    connect() {
      increment('qa-connects');
      return operation(() => {
        if (!present) throw new DOMException('Pendant is asleep', 'NetworkError');
        this.connected = true;
        if (idleOnReconnect) {
          idleOnReconnect = false;
          waiting = false;
          finishing = false;
          buffer = [];
          clearInterval(audioTimer);
        }
        if (!waiting) state = 1;
        if (hideOnConnect) {
          hideOnConnect = false;
          setVisibility('hidden');
        }
        return this;
      });
    },
    getPrimaryService() {
      return operation(() => service);
    },
    disconnect() {
      appDisconnects++;
      loseLink();
    },
  };
  device.watchAdvertisements = async ({ signal }) => {
    watching = true;
    signal.addEventListener(
      'abort',
      () => {
        watching = false;
      },
      { once: true },
    );
  };
  function emit(seq) {
    if (blockAudio) return; // Native BLE accepted the notification; the web view lost it.
    for (let chunk = 0; chunk < 4; chunk++) {
      const v = new DataView(new ArrayBuffer(408));
      v.setUint8(0, 0xa5);
      v.setUint8(1, 2);
      v.setUint16(2, seq, true);
      v.setUint8(4, chunk);
      v.setUint8(5, 4);
      v.setUint16(6, 400, true);
      for (let i = 8; i < 408; i += 2) v.setInt16(i, (seq % 20000) + 1, true);
      audio.value = v;
      audio.dispatchEvent(new Event('characteristicvaluechanged'));
    }
  }
  function startSender() {
    if (sendTimer) clearInterval(sendTimer);
    sendTimer = setInterval(() => {
      if (!device.gatt.connected || waiting || pauseReplay) return;
      if (buffer.length) emit(buffer.shift());
      else if (finishing) {
        clearInterval(sendTimer);
        state = 1;
        finishing = false;
        control.value = status();
        control.dispatchEvent(new Event('characteristicvaluechanged'));
      }
    }, sendIntervalMs);
  }
  function frame() {
    if (buffered) {
      buffer.push(sequence);
      retained.push(sequence);
      if (retained.length > recoveryCapacity) retained.shift();
      if (buffer.length > recoveryCapacity) buffer.shift();
      if (device.gatt.connected && !waiting && !sendTimer) startSender();
    } else emit(sequence);
    sequence = (sequence + 1) & 65535;
  }
  function pendantDoubleTap() {
    if (!device.gatt.connected) return;
    if (state === 2) {
      clearInterval(audioTimer);
      if (buffered && armed) {
        finishing = true;
        const recovery = chars.get(uuid('4f'));
        recovery.value = recoveryStatus();
        recovery.dispatchEvent(new Event('characteristicvaluechanged'));
        startSender();
        return;
      }
      state = 1;
    } else {
      state = 2; sequence = 0; buffer = []; retained = []; finishing = waiting = false;
      clearInterval(audioTimer);
      audioTimer = setInterval(frame, 50);
    }
    control.value = status();
    control.dispatchEvent(new Event('characteristicvaluechanged'));
    // The first audio may follow status in the same native delivery batch.
    if (state === 2) frame();
  }
  let pickerError = null,
    bluetoothAvailable = !location.search.includes('lateBluetooth');
  const bluetooth = new EventTarget();
  bluetooth.requestDevice = async () => {
    if (!navigator.userActivation.isActive)
      throw new DOMException('Device selection needs a direct user tap', 'SecurityError');
    increment('qa-pickers');
    if (pickerError) {
      const error = pickerError;
      pickerError = null;
      throw error;
    }
    sessionStorage.setItem('qa-permitted', '1');
    return device;
  };
  if (!location.search.includes('noRestore'))
    bluetooth.getDevices = async () => (sessionStorage.getItem('qa-permitted') ? [device] : []);
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    get: () => (bluetoothAvailable ? bluetooth : undefined),
  });
  window.bleFixture = {
    pendantDoubleTap,
    notifyStatus() { control.value = status(); control.dispatchEvent(new Event('characteristicvaluechanged')); },
    get inventoryReads() { return inventoryReads; },
    get missingProbes() { return missingProbes; },
    delayNextDiscovery(id, ms) { discoveryDelays.set(uuid(id), ms); },
    get discoveries() { return discoveries; },
    get discoveryBusy() { return discoveryBusy; },
    emptyVoiceStatus(value){emptyVoiceRead=value;},
    voice(action){voiceSequence++;voiceAction=action;voiceResult=voiceEnabled&&Date.now()-voiceLease<6000?2:0;emitVoice();return voiceSequence;},
    replayVoice:emitVoice,
    get voiceLease(){return voiceLease;},
    modelFailAt(offset){modelFailure=offset;},
    get model(){return {state:modelState,offset:modelOffset,begins:modelBegins};},
    get mediaWrites(){return mediaWrites;},
    get mediaCommands(){return mediaCommands;},
    setCardInserted(value){sdInserted=value;},
    get wifiRunning(){return wifiRunning;},
    delayNextCameraReply(){delayCameraReply=true;},
    delayNextCameraRead(ms){cameraReadDelay=ms;},
    get uninitializedMediaReads(){return uninitializedMediaReads;},
    setSdAvailable(value){sdAvailable=value;},
    finishMedia(error=0){mediaError=error;mediaState=error?3:2;},
    blockAudio(value) { blockAudio = value; },
    setAudioSendInterval(ms) { sendIntervalMs=ms;if(sendTimer)startSender(); },
    loseNotifications() { blockAudio=true;restoreOnSubscribe=true; },
    pendantStop() {
      clearInterval(audioTimer);finishing=true;
      const recovery=chars.get(uuid('4f'));recovery.value=recoveryStatus();
      recovery.dispatchEvent(new Event('characteristicvaluechanged'));startSender();
    },
    get replayCommands() { return replayCommands; },
    get audioSubscriptions() { return audioSubscriptions; },
    disconnect: loseLink,
    enableBluetooth() {
      bluetoothAvailable = true;
    },
    rejectNextPicker(name, message) {
      pickerError = new DOMException(message, name);
    },
    get otaBegins() {
      return otaBegins;
    },
    get otaCommits() {
      return otaCommits;
    },
    get otaOffset() {
      return otaOffset;
    },
    get firmwareBuild() {
      return firmwareBuild;
    },
    holdFirmware(value) {
      otaHold = value;
    },
    get maximum() {
      return maxInFlight;
    },
    get watching() {
      return watching;
    },
    get captured() {
      return sequence;
    },
    get pendingFrames() {
      return buffer.length;
    },
    emulateStopEcho(value) { echoStop=value;rejectStopResponse=value;control.properties.writeWithoutResponse=value; },
    rejectNextStops(count) { rejectStops=count; },
    get responseStopAttempts() { return responseStopAttempts; },
    get stopWrites() { return stopWrites; },
    get recoveryWaiting() {
      return waiting;
    },
    get armed() {
      return armed;
    },
    interruptNextStop(mode) {
      stopDisconnect = mode;
    },
    holdReplay(value) {
      pauseReplay = value;
    },
    expireBuffer() {
      idleOnReconnect = true;
    },
    invalidRecoveryOnce() {
      invalidRecoveryReads = 1;
    },
    get appDisconnects() {
      return appDisconnects;
    },
    get statusReads() {
      return statusReads;
    },
    get readError() {
      return readError;
    },
    get readPending() {
      return Boolean(releaseRead);
    },
    hideOnNextConnect() {
      hideOnConnect = true;
    },
    show: () => setVisibility('visible'),
    hide: () => setVisibility('hidden'),
    delayStatusRead() {
      readError = null;
      SynapDevices.connection
        .queue(() => { holdRead = true; return control.readValue(); }, 'Delayed diagnostic read')
        .catch((error) => {
          readError = error.name;
        });
    },
    finishRead() {
      holdRead = false;
      releaseRead?.();
      releaseRead = null;
    },
    delayStopCommand() { holdStop = true; },
    finishStopCommand() { releaseStop?.(); releaseStop = null; },
    get connects() {
      return count('qa-connects');
    },
    get pickers() {
      return count('qa-pickers');
    },
    get starts() {
      return count('qa-starts');
    },
    disableAdvertisements() {
      delete device.watchAdvertisements;
    },
    sleep() {
      const events = chars.get(uuid('4e'));
      events.value = new DataView(new Uint8Array([0xe2, 1, 3, 1, 0x82, 4]).buffer);
      events.dispatchEvent(new Event('characteristicvaluechanged'));
      present = false;
      loseLink();
    },
    wake() {
      present = true;
      if (watching) {
        const event = new Event('advertisementreceived');
        event.device = device;
        device.dispatchEvent(event);
      }
    },
  };
};
