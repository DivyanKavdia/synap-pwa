/* Optional firmware extension; older pendants retain their normal reconnect path. */
(function(root){
  'use strict';
  const UUID='4fa1234f-0000-1000-8000-00805f9b34fb';
  let characteristic=null,queue=null,token=null,lastSequence=0xffff,capacity=0;
  function report(value){const node=root.document?.getElementById?.("disconnectProtectionStatus");if(node){node.textContent=value;node.hidden=!value;}}
  const delay=ms=>new Promise(resolve=>root.setTimeout(resolve,ms));
  function status(value){
    if(!value||value.byteLength!==16||value.getUint8(0)!==0x52||value.getUint8(1)!==1)return null;
    const flags=value.getUint8(2),frames=value.getUint16(4,true);
    if(frames>600)return null;
    return {tokenHash:value.getUint32(12,true),finishing:Boolean(flags&8),available:Boolean(flags&1)&&frames>0,armed:Boolean(flags&2),waiting:Boolean(flags&4),frames};
  }
  function onStatus(event){const info=status(event.target.value);if(info?.finishing)root.dispatchEvent(new CustomEvent("synap-recording-draining"));}
  async function discover(service,operation,assertConnection,resuming=false){
    detach();queue=operation;
    try{
      const found=await queue(()=>service.getCharacteristic(UUID));assertConnection();
      const info=status(await queue(()=>found.readValue()));assertConnection();
      if(!info && resuming && token)throw new Error("Pendant recovery information was incomplete. Retrying the connection.");
      if(!info?.available){report("Audio recovery is unavailable on this connection.");return null;}
      characteristic=found;capacity=info.frames;
      found.addEventListener("characteristicvaluechanged",onStatus);
      await queue(()=>found.startNotifications());assertConnection();return info;
    }catch(error){detach();assertConnection();if(resuming&&token&&error.name!=="NotFoundError")throw error;return null;}
  }
  function tokenHash(){let hash=2166136261;for(const byte of token||[])hash=Math.imul(hash^byte,16777619)>>>0;return hash;}
  async function send(command,sequence){
    if(!characteristic||!queue||!token)return null;
    const value=new Uint8Array(command===2?11:9);value[0]=command;value.set(token,1);
    if(command===2){value[9]=sequence&255;value[10]=sequence>>8;}
    const target=characteristic;
    await queue(()=>target.writeValueWithResponse(value));
    let info=null;
    for(let attempt=0;attempt<10;attempt++){
      await delay(60);info=status(await queue(()=>target.readValue()));
      if(info?.armed&&info.tokenHash===tokenHash()&&(command===1||!info.waiting))return info;
    }
    return info;
  }
  async function arm(){
    if(!characteristic||!root.crypto?.getRandomValues)return false;
    token=root.crypto.getRandomValues(new Uint8Array(8));lastSequence=0xffff;
    const info=await send(1);if(!info?.armed || info.tokenHash!==tokenHash()){return false;}report("Audio recovery: up to "+(capacity/20)+" seconds across brief disconnects.");return true;
  }
  function canResume(info){return Boolean(info?.waiting&&info?.armed&&token&&info.tokenHash===tokenHash())}
  async function resume(){
    const info=await send(2,lastSequence);
    if(!info?.armed||info.waiting||info.tokenHash!==tokenHash())throw new Error('Pendant audio recovery was not acknowledged. Retrying the connection.');
    report("Audio recovery: up to "+(capacity/20)+" seconds across brief disconnects.");
    return true;
  }
  function received(sequence){lastSequence=sequence;}
  function resetRecording(){lastSequence=0xffff;}
  function detach(){report("");characteristic?.removeEventListener("characteristicvaluechanged",onStatus);characteristic=null;queue=null;capacity=0;}
  root.SynapDisconnectProtection=Object.freeze({discover,arm,canResume,resume,received,resetRecording,detach,status,capacityMs:()=>capacity*50});
})(globalThis);
