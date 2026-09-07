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
      root.setTimeout(function(){if(!busy()&&root.location?.reload)root.location.reload()},450);
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
  function scan(){root.document?.querySelectorAll?.('.recording-card').forEach(enhance)}
  function init(){scan();if(!root.document?.body)return;new MutationObserver(scan).observe(root.document.body,{childList:true,subtree:true})}
  if(root.document?.readyState==='loading')root.document.addEventListener('DOMContentLoaded',init,{once:true});else init();
  root.SynapTranscriptRepair={repair:repair,saveMemory:saveMemory,recordingId:recordingId,busy:busy};
})(globalThis);
