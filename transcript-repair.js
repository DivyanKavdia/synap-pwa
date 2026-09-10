/* Repair legacy cloud memories from already-sealed 30-second transcript windows. */
(function(root){'use strict';
  var DB='dk-pendant-recordings';
  var STORE='recordings';
  var BUSY=['recording','starting','stopping','saving','updating'];
  var active=new Set();
  var autoAttempted=new Set();
  var autoActive=false;
  var autoTimer=null;

  function signedIn(){try{return Boolean(root.SynapAuth?.isSignedIn?.())}catch(_){return false}}
  function synapProvider(){try{return String(JSON.parse(root.localStorage.getItem('synap-ai-provider-settings')||'{}').provider||'synap')==='synap'}catch(_){return true}}
  function busy(){return BUSY.indexOf(String(root.document?.body?.dataset?.state||''))!==-1}
  function recordingId(card){return String(card?.id||'').replace(/^recording-/,'')}
  function request(path,options){
    if(!root.SynapAuth?.authedFetch)return Promise.reject(new Error('Synap account is unavailable.'));
    return root.SynapAuth.authedFetch(path,options||{}).then(async function(response){
      var data=null;try{data=await response.json()}catch(_){}
      if(!response.ok){var e=new Error(data?.error?.message||('HTTP '+response.status));e.status=response.status;throw e}
      return data||{};
    });
  }
  function emit(name,detail){
    try{if(typeof root.dispatchEvent==='function'&&typeof root.CustomEvent==='function')root.dispatchEvent(new root.CustomEvent(name,{detail:detail||{}}))}catch(_){}
  }
  function waitUntilReady(id,deadline){
    return request('/v1/recordings/'+encodeURIComponent(id)+'/processing').then(function(status){
      var state=String(status.state||'');
      if(state==='ready')return status;
      if(state==='failed')throw new Error(status.error_code||'Memory rebuild failed.');
      if(Date.now()>deadline)throw new Error('Memory rebuild is still running. Try Refresh memory again shortly.');
      return new Promise(function(resolve){root.setTimeout(resolve,2500)}).then(function(){return waitUntilReady(id,deadline)});
    });
  }
  function openDb(){return new Promise(function(resolve,reject){var q=root.indexedDB.open(DB);q.onsuccess=function(){resolve(q.result)};q.onerror=function(){reject(q.error)}})}
  function localDay(value){
    var date=value instanceof Date?value:new Date(value||Date.now());
    if(Number.isNaN(date.getTime()))return '';
    return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
  }
  function selectedDay(){
    try{var picker=root.document?.getElementById?.('datePicker');if(picker?.value)return String(picker.value)}catch(_){}
    return localDay(new Date());
  }
  function recordDay(record){return String(record?.day||localDay(record?.createdAt||record?.startedAt||''))}
  function legacyConversationMemory(record){
    var conversations=Array.isArray(record?.conversations)?record.conversations:[];
    if(!conversations.length)return false;
    var missingSemantics=conversations.some(function(conversation){
      return !Array.isArray(conversation?.participants)||!Array.isArray(conversation?.mentioned_people);
    });
    var allZero=conversations.length>1&&conversations.every(function(conversation){
      return Number(conversation?.start_ms??conversation?.startMs??0)===0;
    });
    return missingSemantics||allZero;
  }
  function readySynapRecord(record){
    return Boolean(record&&record.id&&String(record.provider||'synap')==='synap'&&
      (record.processingStage==='ready'||record.processingState==='done'||record.restoredFromCloud===true));
  }
  function buttonState(button,text,disabled,title){
    if(!button)return;
    if(text!==undefined)button.textContent=text;
    if(disabled!==undefined)button.disabled=Boolean(disabled);
    if(title!==undefined)button.title=title||'';
  }
  async function saveMemory(id,memory){
    var db=await openDb();
    try{
      await new Promise(function(resolve,reject){
        var tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),get=store.get(id);
        get.onsuccess=function(){
          if(!get.result)return;
          var fields=root.SynapBackend?.toRecordingFields?.(memory)||{};
          var transcript=typeof memory.transcript==='string'?memory.transcript:String(get.result.transcript||'');
          var rebuiltAt=new Date().toISOString();
          store.put(Object.assign({},get.result,fields,{transcript:transcript,
            durationMs:Math.max(Number(get.result.durationMs)||0,Number(memory.duration_ms)||0),
            transcriptRebuiltAt:rebuiltAt,semanticRebuiltAt:rebuiltAt}));
        };
        tx.oncomplete=function(){resolve()};tx.onerror=tx.onabort=function(){reject(tx.error||new Error('Could not update local memory.'))};
      });
    }finally{db.close()}
  }
  async function repair(id,button){
    id=String(id||'');
    if(!id||active.has(id))return false;
    if(busy()){
      if(button){buttonState(button,'Stop recording first');root.setTimeout(function(){buttonState(button,'Refresh memory',false)},1800)}
      return false;
    }
    if(!signedIn()){
      if(button){buttonState(button,'Sign in first');root.setTimeout(function(){buttonState(button,'Refresh memory',false)},1800)}
      return false;
    }
    active.add(id);buttonState(button,'Rebuilding memory…',true);
    try{
      var start=await request('/v1/recordings/'+encodeURIComponent(id)+'/process-now?force=true',{method:'POST'});
      if(start.rebuilt!==true)throw new Error('Synap Cloud needs the transcript-only memory rebuild update before this recording can be repaired.');
      if(Number(start.retranscribed_segments||0)!==0)throw new Error('Safety check failed: this rebuild attempted transcription.');
      if(String(start.state||'')!=='ready')await waitUntilReady(id,Date.now()+10*60*1000);
      var memory=await request('/v1/recordings/'+encodeURIComponent(id)+'/memory');
      if(!String(memory.transcript||'').trim())throw new Error('The rebuilt recording still has no transcript.');
      await saveMemory(id,memory);
      buttonState(button,'Memory refreshed',true);
      emit('synap-memory-ready',{recordingId:id,source:'legacy-memory-rebuild'});
      emit('synap-cloud-history-updated',{recordingId:id,source:'legacy-memory-rebuild'});
      if(button)root.setTimeout(function(){buttonState(button,'Refresh memory',false)},1200);
      return true;
    }catch(error){
      console.warn('[synap memory] rebuild failed',error);
      buttonState(button,'Retry memory',false,error?.message||'Memory rebuild failed');
      return false;
    }finally{active.delete(id)}
  }
  async function localRecords(){
    var db=await openDb();
    try{return await new Promise(function(resolve,reject){var tx=db.transaction(STORE,'readonly'),q=tx.objectStore(STORE).getAll();q.onsuccess=function(){resolve(q.result||[])};q.onerror=function(){reject(q.error)}})}
    finally{db.close()}
  }
  async function autoRepairToday(){
    if(autoActive||busy()||!signedIn()||!synapProvider())return;
    autoActive=true;
    try{
      var day=selectedDay();
      var records=await localRecords();
      var candidates=(records||[]).filter(function(record){
        return readySynapRecord(record)&&recordDay(record)===day&&legacyConversationMemory(record)&&!autoAttempted.has(String(record.id));
      }).sort(function(a,b){return String(a.createdAt||'').localeCompare(String(b.createdAt||''))}).slice(0,12);
      for(var index=0;index<candidates.length;index+=1){
        if(busy()||!signedIn())break;
        var id=String(candidates[index].id);autoAttempted.add(id);
        await repair(id,null);
      }
    }catch(error){console.warn('[synap memory] automatic legacy rebuild skipped',error)}
    finally{autoActive=false}
  }
  function scheduleAutoRepair(delay){
    if(autoTimer)root.clearTimeout(autoTimer);
    autoTimer=root.setTimeout(function(){autoTimer=null;void autoRepairToday()},Math.max(0,Number(delay)||0));
  }
  function enhance(card){
    if(!card||card.dataset.synapTranscriptRepair==='1')return;
    var id=recordingId(card),actions=card.querySelector('.recording-actions');
    if(!id||!actions||!signedIn()||!synapProvider())return;
    card.dataset.synapTranscriptRepair='1';
    var button=root.document.createElement('button');button.type='button';button.className='text-button synap-transcript-repair';
    button.textContent='Refresh memory';button.title='Rebuild timing and conversation semantics from Synap Cloud’s stored 30-second transcript windows without retranscribing audio.';
    button.addEventListener('click',function(){repair(id,button)});actions.appendChild(button);
  }
  function installBackendMemoryFetch(){
    if(!root.SynapBackend||typeof root.SynapBackend.recordingMemory==='function')return;
    root.SynapBackend.recordingMemory=function(id){return request('/v1/recordings/'+encodeURIComponent(id)+'/memory')};
  }
  function installProcessorEvents(){
    var Processor=root.DKFIFOProcessor;
    if(!Processor||Processor.prototype.__synapEventRefreshPatched)return false;
    var original=Processor.prototype.process;
    if(typeof original!=='function')return false;
    Processor.prototype.process=function(job){
      var self=this,args=arguments;
      emit('synap-processing-state',{recordingId:job&&job.recordingId,kind:job&&job.kind,state:'running'});
      var result;
      try{result=original.apply(self,args)}catch(error){emit('synap-processing-state',{recordingId:job&&job.recordingId,kind:job&&job.kind,state:'failed'});throw error}
      return Promise.resolve(result).then(function(value){
        emit('synap-processing-state',{recordingId:job&&job.recordingId,kind:job&&job.kind,state:'done'});
        return value;
      },function(error){emit('synap-processing-state',{recordingId:job&&job.recordingId,kind:job&&job.kind,state:'failed'});throw error});
    };
    Processor.prototype.__synapEventRefreshPatched=true;
    return true;
  }
  function installEventBridge(){
    installBackendMemoryFetch();
    if(installProcessorEvents())return;
    var attempts=0,timer=root.setInterval(function(){attempts+=1;installBackendMemoryFetch();if(installProcessorEvents()||attempts>=80)root.clearInterval(timer)},50);
  }
  function scan(){root.document?.querySelectorAll?.('.recording-card').forEach(enhance)}
  function init(){
    scan();installEventBridge();scheduleAutoRepair(1600);
    if(typeof root.addEventListener==='function')root.addEventListener('synap-cloud-history-updated',function(){scheduleAutoRepair(900)});
    if(!root.document?.body)return;
    new MutationObserver(scan).observe(root.document.body,{childList:true,subtree:true});
  }
  if(root.document?.readyState==='loading')root.document.addEventListener('DOMContentLoaded',init,{once:true});else init();
  root.SynapTranscriptRepair={repair:repair,saveMemory:saveMemory,recordingId:recordingId,busy:busy,legacyConversationMemory:legacyConversationMemory,autoRepairToday:autoRepairToday,installEventBridge:installEventBridge};
})(globalThis);
