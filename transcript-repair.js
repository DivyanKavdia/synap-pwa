/* Repair a cloud transcript from its already-sealed 30-second segment transcripts. */
(function(root){'use strict';
  var DB='dk-pendant-recordings';
  var STORE='recordings';
  var BUSY=['recording','starting','stopping','saving','updating'];
  var active=new Set();

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
      if(state==='failed')throw new Error(status.error_code||'Transcript rebuild failed.');
      if(Date.now()>deadline)throw new Error('Transcript rebuild is still running. Try Refresh transcript again shortly.');
      return new Promise(function(resolve){root.setTimeout(resolve,2500)}).then(function(){return waitUntilReady(id,deadline)});
    });
  }
  function openDb(){return new Promise(function(resolve,reject){var q=root.indexedDB.open(DB);q.onsuccess=function(){resolve(q.result)};q.onerror=function(){reject(q.error)}})}
  async function saveMemory(id,memory){
    var db=await openDb();
    try{
      await new Promise(function(resolve,reject){
        var tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),get=store.get(id);
        get.onsuccess=function(){
          if(!get.result)return;
          var fields=root.SynapBackend?.toRecordingFields?.(memory)||{};
          var transcript=typeof memory.transcript==='string'?memory.transcript:String(get.result.transcript||'');
          store.put(Object.assign({},get.result,fields,{transcript:transcript,
            durationMs:Math.max(Number(get.result.durationMs)||0,Number(memory.duration_ms)||0),
            transcriptRebuiltAt:new Date().toISOString()}));
        };
        tx.oncomplete=function(){resolve()};tx.onerror=tx.onabort=function(){reject(tx.error||new Error('Could not update local transcript.'))};
      });
    }finally{db.close()}
  }
  async function repair(id,button){
    if(!id||active.has(id))return;
    if(busy()){button.textContent='Stop recording first';root.setTimeout(function(){button.textContent='Refresh transcript'},1800);return}
    if(!signedIn()){button.textContent='Sign in first';root.setTimeout(function(){button.textContent='Refresh transcript'},1800);return}
    active.add(id);button.disabled=true;button.textContent='Rebuilding transcript…';
    try{
      var start=await request('/v1/recordings/'+encodeURIComponent(id)+'/process-now?force=true',{method:'POST'});
      if(start.rebuilt!==true)throw new Error('Synap Cloud needs the transcript-rebuild backend update before this recording can be repaired.');
      if(String(start.state||'')!=='ready')await waitUntilReady(id,Date.now()+10*60*1000);
      var memory=await request('/v1/recordings/'+encodeURIComponent(id)+'/memory');
      if(!String(memory.transcript||'').trim())throw new Error('The rebuilt recording still has no transcript.');
      await saveMemory(id,memory);
      button.textContent='Transcript restored';
      emit('synap-memory-ready',{recordingId:id,source:'transcript-repair'});
      emit('synap-cloud-history-updated',{recordingId:id,source:'transcript-repair'});
      root.setTimeout(function(){button.disabled=false;button.textContent='Refresh transcript'},1200);
    }catch(error){
      console.warn('[synap transcript] rebuild failed',error);
      button.disabled=false;button.textContent='Retry transcript';button.title=error?.message||'Transcript rebuild failed';
    }finally{active.delete(id)}
  }
  function enhance(card){
    if(!card||card.dataset.synapTranscriptRepair==='1')return;
    var id=recordingId(card),actions=card.querySelector('.recording-actions');
    if(!id||!actions||!signedIn()||!synapProvider())return;
    card.dataset.synapTranscriptRepair='1';
    var button=root.document.createElement('button');button.type='button';button.className='text-button synap-transcript-repair';
    button.textContent='Refresh transcript';button.title='Rebuild the complete transcript from Synap Cloud’s stored 30-second transcript windows.';
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
        if(job&&job.kind==='consolidate')emit('synap-memory-ready',{recordingId:job.recordingId,source:'processor'});
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
  function init(){scan();installEventBridge();if(!root.document?.body)return;new MutationObserver(scan).observe(root.document.body,{childList:true,subtree:true})}
  if(root.document?.readyState==='loading')root.document.addEventListener('DOMContentLoaded',init,{once:true});else init();
  root.SynapTranscriptRepair={repair:repair,saveMemory:saveMemory,recordingId:recordingId,busy:busy,installEventBridge:installEventBridge};
})(globalThis);
