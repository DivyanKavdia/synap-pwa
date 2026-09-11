/* Persistent intentional-sleep guard for Synap BLE reconnect. */
(function(root){
  'use strict';
  const AUTO_RECONNECT_KEY='dk-pendant-auto-reconnect';
  const SLEEP_STATE_KEY='synap-intentional-sleep-v1';
  const SAVED_RECONNECT_KEY='synap-reconnect-before-sleep-v1';
  const POWER_EVENT_MAGIC=0xE2;
  const POWER_EVENT_VERSION=1;
  const POWER_STATE_DEEP_SLEEP=3;
  let memoryLocked=false,savedPreference='on';

  function get(key){try{return root.localStorage?.getItem(key)??null}catch(_){return null}}
  function set(key,value){try{root.localStorage?.setItem(key,value);return true}catch(_){return false}}
  function remove(key){try{root.localStorage?.removeItem(key)}catch(_){}}
  function locked(){return memoryLocked||get(SLEEP_STATE_KEY)==='1'}
  function reconnectOnWake(){return (memoryLocked?savedPreference:(get(SAVED_RECONNECT_KEY)||savedPreference))!=='off'}
  function parseHex(hex){return String(hex||'').trim().split(/\s+/).filter(Boolean).map(v=>Number.parseInt(v,16))}
  function currentReconnectPreference(){
    const checkbox=document.getElementById('autoReconnectInput');
    if(checkbox&&typeof checkbox.checked==='boolean')return checkbox.checked?'on':'off';
    const stored=get(AUTO_RECONNECT_KEY);
    return stored==='off'?'off':'on';
  }
  function reflectLocked(){
    if(!document.body)return;
    document.body.dataset.intentionalSleep='1';
    document.body.dataset.powerState='deep-sleep';
  }
  function forceReconnectOff(){
    set(AUTO_RECONNECT_KEY,'off');
    reflectLocked();
  }
  function beginSleepLock(){
    const alreadyLocked=locked();
    if(alreadyLocked)savedPreference=reconnectOnWake()?'on':'off';
    if(!alreadyLocked){
      savedPreference=currentReconnectPreference();
      set(SAVED_RECONNECT_KEY,savedPreference);
      set(SLEEP_STATE_KEY,'1');
    }
    memoryLocked=true;
    forceReconnectOff();
    if(!alreadyLocked)root.dispatchEvent?.(new CustomEvent('synap-intentional-sleep',{detail:{active:true,owner:'sleep-state-guard'}}));
  }
  function clearSleepLock(){
    if(!locked())return;
    const previous=reconnectOnWake()?'on':'off';
    memoryLocked=false;
    remove(SLEEP_STATE_KEY);
    remove(SAVED_RECONNECT_KEY);
    set(AUTO_RECONNECT_KEY,previous);
    if(document.body){
      delete document.body.dataset.intentionalSleep;
      document.body.dataset.powerState='awake';
    }
    const checkbox=document.getElementById('autoReconnectInput');
    if(checkbox)checkbox.checked=previous!=='off';
    root.dispatchEvent?.(new CustomEvent('synap-intentional-sleep',{detail:{active:false,owner:'sleep-state-guard'}}));
  }
  function setReconnectPreference(enabled){
    const value=enabled?'on':'off';
    if(locked()){
      if(!set(SAVED_RECONNECT_KEY,value))throw new Error('Could not save the reconnect preference.');
      savedPreference=value;forceReconnectOff();
    }else if(!set(AUTO_RECONNECT_KEY,value))throw new Error('Could not save the reconnect preference.');
  }
  function handlePowerPacket(event){
    const bytes=parseHex(event?.detail?.hex);
    if(bytes.length!==6||bytes[0]!==POWER_EVENT_MAGIC||bytes[1]!==POWER_EVENT_VERSION)return;
    if(bytes[2]===POWER_STATE_DEEP_SLEEP)beginSleepLock();
  }
  function handleBridgeIntent(event){
    if(event?.detail?.active===false&&locked())forceReconnectOff();
    if(event?.detail?.active===true)beginSleepLock();
  }
  function bind(){
    if(locked())forceReconnectOff();
    root.addEventListener('synap-event-packet',handlePowerPacket);
    root.addEventListener('synap-intentional-sleep',handleBridgeIntent);
    // A new live GATT service can only appear after the user has woken/reconnected the pendant.
    root.addEventListener('synap-gatt-service-ready',()=>clearSleepLock());
    root.addEventListener('storage',event=>{
      if(locked()&&(event.key===AUTO_RECONNECT_KEY||event.key===SLEEP_STATE_KEY))forceReconnectOff();
    });
  }
  root.SynapSleepStateGuard={
    AUTO_RECONNECT_KEY,SLEEP_STATE_KEY,SAVED_RECONNECT_KEY,
    get locked(){return locked()},get reconnectOnWake(){return reconnectOnWake()},
    beginSleepLock,clearSleepLock,forceReconnectOff,setReconnectPreference
  };
  // Restoring a permitted pendant can finish while the remaining scripts load.
  // Subscribe now so that service readiness cannot leave a stale sleep lock.
  bind();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{if(locked())reflectLocked()},{once:true});
})(globalThis);
