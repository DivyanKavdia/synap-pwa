/* Battery, touch and power notifications share the recorder's GATT queue. */
(function(root){'use strict';
const EVENT_UUID='4fa1234e-0000-1000-8000-00805f9b34fb';
const CONTROL_UUID='4fa12347-0000-1000-8000-00805f9b34fb';
let connection=null,characteristic=null,mode='none',attachTimer=0,attachEpoch=0,attaching=null,lastPacket=null,attempts=0;
function packetBytes(value){try{return Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}catch(_){return''}}
function inspect(event,source){
  try{
    const value=event?.target?.value;
    if(value){lastPacket={source,bytes:value.byteLength,hex:packetBytes(value),at:Date.now()};root.dispatchEvent(new CustomEvent('synap-event-packet',{detail:lastPacket}))}
    if(root.SynapMemoryEventBridge?.inspect)return root.SynapMemoryEventBridge.inspect(event);
    if(root.SynapBatteryBridge?.inspect)return root.SynapBatteryBridge.inspect(event);
  }catch(error){console.warn('[synap events] packet handling failed',error)}
}
function setMode(next){mode=next;if(document.body)document.body.dataset.eventChannel=next}
function clear(){
  ++attachEpoch;
  if(attachTimer){clearTimeout(attachTimer);attachTimer=0}
  if(characteristic)characteristic.removeEventListener('characteristicvaluechanged',handleEvent);
  connection=null;characteristic=null;attaching=null;lastPacket=null;attempts=0;setMode('none');
}
function handleEvent(event){if(event.target===characteristic)inspect(event,'event')}
function attachDedicatedEvent(){
  if(attaching)return attaching;
  if(!connection?.queue||mode==='event'||mode==='legacy-control')return Promise.resolve(mode==='event');
  const current=connection,epoch=attachEpoch;
  attempts+=1;
  const job=(async()=>{
    try{
      const next=await current.queue(()=>current.service.getCharacteristic(EVENT_UUID),'Find pendant events');
      if(epoch!==attachEpoch)return false;
      characteristic=next;
      characteristic.addEventListener('characteristicvaluechanged',handleEvent);
      await current.queue(()=>next.startNotifications(),'Subscribe pendant events');
      if(epoch!==attachEpoch)return false;
      setMode('event');
      root.dispatchEvent(new CustomEvent('synap-event-channel-ready',{detail:{mode:'event'}}));
      try{
        const value=await current.queue(()=>next.readValue(),'Read retained pendant event');
        if(epoch===attachEpoch&&value?.byteLength)inspect({target:{value}},'event-read');
      }catch(error){if(epoch===attachEpoch)console.warn('[synap events] retained EVENT read failed',error)}
      return true;
    }catch(error){
      if(epoch!==attachEpoch)return false;
      if(characteristic)characteristic.removeEventListener('characteristicvaluechanged',handleEvent);
      characteristic=null;
      setMode(error?.name==='NotFoundError'?'legacy-control':'unavailable');
      if(mode==='unavailable'&&attempts<3)schedule(1600);
      return false;
    }
  })();
  attaching=job;
  job.finally(()=>{if(attaching===job)attaching=null});
  return job;
}
function schedule(delay=700){
  if(attachTimer)clearTimeout(attachTimer);
  attachTimer=setTimeout(()=>{attachTimer=0;attachDedicatedEvent()},delay);
}
root.addEventListener('synap-gatt-service-ready',event=>{
  clear();connection=event.detail;setMode('service-ready');schedule();
});
root.addEventListener('synap-gatt-disconnected',clear);
root.addEventListener('synap-recording-foreground',()=>{
  if(connection&&mode!=='event'&&mode!=='legacy-control'){attempts=0;schedule(150)}
});
root.SynapEventChannel={EVENT_UUID,CONTROL_UUID,get mode(){return mode},get lastPacket(){return lastPacket},attach:attachDedicatedEvent,reset:clear};
})(globalThis);
