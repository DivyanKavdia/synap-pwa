/* Recording filters and selection share the existing mounted Library cards. */
(function(root){
  'use strict';
  const filters=[['all','All statuses'],['transcript','Needs transcript'],['summary','Needs summary'],['retry','Needs retry'],['processing','Processing'],['ready','Ready']];
  const selected=new Set();
  let config=null,installed=false,selecting=false,busy=false,filter='all',jobs=new Map(),records=[],matches=[],deleteIds=[];
  const $=id=>root.document?.getElementById(id);
  const text=value=>String(value||'').trim();
  function provider(){try{return JSON.parse(root.localStorage.getItem('synap-ai-provider-settings')||'{}').provider||'synap';}catch(_){return 'synap';}}
  function state(recording,recordingJobs=[],currentProvider='synap'){
    const stage=text(recording.processingStage).toLowerCase();
    const failure=stage==='failed'||recordingJobs.some(job=>job.state==='failed');
    const protectedRecording=recording.status==='recording'||recording.sealed===false;
    const ready=!protectedRecording&&(stage==='ready'||(!failure&&(recording.processingState==='done'||
      (!stage&&text(recording.transcript)&&text(recording.summary)))));
    const failed=!ready&&failure;
    const running=recordingJobs.some(job=>job.state==='running');
    const active=!ready&&!failed&&(protectedRecording||['uploading','uploaded','transcribing','understanding','indexing'].includes(stage)||running);
    const transcription=recordingJobs.filter(job=>job.kind==='transcribe');
    // A cloud upload job is not evidence that speech has been transcribed.
    const custom=(recording.provider||currentProvider)==='custom';
    const transcriptDone=Boolean(ready||recording.transcriptComplete===true||['understanding','indexing'].includes(stage)||
      (recording.transcriptComplete!==false&&text(recording.transcript))||
      (custom&&transcription.length&&transcription.every(job=>job.state==='done')));
    const summaryDone=Boolean(ready||stage==='indexing'||(!failed&&text(recording.summary)));
    return {ready:Boolean(ready),active,failed,protectedRecording,transcriptDone,summaryDone,
      canProcess:!ready&&!running&&!protectedRecording&&(!failed||recording.processingRetryable!==false)};
  }
  function matchesStatus(recording,key,recordingJobs=[],currentProvider='synap'){
    const value=state(recording,recordingJobs,currentProvider);
    if(key==='transcript')return !value.transcriptDone;
    if(key==='summary')return !value.summaryDone;
    if(key==='retry')return value.failed;
    if(key==='processing')return value.active;
    if(key==='ready')return value.ready;
    return true;
  }
  function model(recording){return state(recording,jobs.get(String(recording.id))||[],provider());}
  function selectable(recording){return config?.protected?!config.protected(recording):!model(recording).protectedRecording;}
  function setJobs(values){jobs=new Map();for(const job of values||[]){const id=String(job.recordingId);if(!jobs.has(id))jobs.set(id,[]);jobs.get(id).push(job);}}
  function announce(message,error=false){const node=$('libraryActionStatus');if(!node)return;node.hidden=!message;node.textContent=message||'';node.dataset.error=String(error);}
  function decorate(card,recording){
    let label=card.querySelector('.recording-select');
    if(!label){
      label=root.document.createElement('label');label.className='recording-select';
      const input=root.document.createElement('input');input.type='checkbox';input.className='recording-select-input';
      label.appendChild(input);card.querySelector('.recording-row').prepend(label);
      label.addEventListener('click',event=>event.stopPropagation());
      input.addEventListener('change',()=>{input.checked?selected.add(String(recording.id)):selected.delete(String(recording.id));paint();});
    }
    const input=label.querySelector('input');
    input.setAttribute('aria-label','Select '+(recording.name||'recording'));
    input.checked=selected.has(String(recording.id));input.disabled=busy||!selectable(recording);
    label.hidden=!selecting;card.classList.toggle('is-selecting',selecting);card.classList.toggle('is-selected',selecting&&input.checked);
  }
  function paint(){
    if(!$('selectRecordingsButton'))return;
    const eligible=matches.filter(selectable),picked=records.filter(r=>selected.has(String(r.id)));
    const count=picked.length,processable=picked.filter(r=>model(r).canProcess).length;
    $('selectRecordingsButton').textContent=selecting?'Done':'Select';
    $('selectRecordingsButton').setAttribute('aria-pressed',String(selecting));
    $('selectRecordingsButton').disabled=busy||(!selecting&&!records.length);
    $('librarySelectionBar').hidden=!selecting;
    $('librarySelectedCount').textContent=count+' selected';
    $('selectAllRecordingsLabel').textContent='Select all '+eligible.length;
    const all=$('selectAllRecordings');
    all.checked=eligible.length>0&&eligible.every(r=>selected.has(String(r.id)));
    all.indeterminate=count>0&&!all.checked;all.disabled=busy||!eligible.length;
    $('processSelectedRecordings').disabled=busy||!processable;
    $('deleteSelectedRecordings').disabled=busy||!count;
    $('libraryStatusFilter').disabled=busy;
    for(const id of ['librarySearch','clearLibrarySearch','clearRecordingFilters'])if($(id))$(id).disabled=busy;
    root.document.querySelectorAll('[data-library-scope]').forEach(node=>node.disabled=busy);
    $('clearRecordingFilters').hidden=filter==='all';
    root.document.querySelectorAll('#recordingsList .recording-card').forEach(card=>{if(card.synapRecording)decorate(card,card.synapRecording);});
  }
  function update(queryMatches,visibleMatches){
    records=queryMatches;matches=visibleMatches;
    const ids=new Set(matches.filter(selectable).map(r=>String(r.id)));
    if(!busy)for(const id of selected)if(!ids.has(id))selected.delete(id);
    const control=$('libraryStatusFilter');
    if(control)for(const option of control.options){const label=filters.find(entry=>entry[0]===option.value)?.[1]||option.value;
      option.textContent=label+' ('+records.filter(r=>matchesStatus(r,option.value,jobs.get(String(r.id))||[],provider())).length+')';}
    paint();
  }
  function report(result,verb){
    const done=result.done||[],failed=result.failed||[],skipped=result.skipped||[];
    const parts=[done.length+' recording'+(done.length===1?'':'s')+' '+verb+'.'];
    if(skipped.length)parts.push(skipped.length+' skipped: '+skipped[0].message);
    if(failed.length)parts.push(failed.length+' failed: '+failed[0].message);
    return parts.join(' ');
  }
  async function processIds(ids){
    if(busy||!config)return;
    busy=true;paint();announce('Preparing selected recordings…');
    try{
      const result=await config.process([...new Set(ids)],(done,total)=>announce('Preparing '+done+' of '+total+'…'));
      result.done.forEach(id=>selected.delete(String(id)));
      announce(report(result,'queued for processing'),result.failed.length>0);
    }catch(error){announce(error.message||'Processing could not start.',true);}
    finally{busy=false;await config.refresh();paint();}
  }
  function requestDelete(ids){
    if(busy||!config)return;
    deleteIds=[...new Set(ids.map(String))];if(!deleteIds.length)return;
    $('deleteRecordingsTitle').textContent='Delete '+deleteIds.length+' recording'+(deleteIds.length===1?'':'s')+'?';
    $('deleteRecordingsStatus').textContent='';
    $('deleteRecordingsCloud').checked=false;
    $('deleteRecordingsCloud').disabled=!root.SynapAuth?.isSignedIn?.();
    $('deleteRecordingsCloudHint').hidden=Boolean(root.SynapAuth?.isSignedIn?.());
    $('confirmDeleteRecordings').textContent='Delete '+deleteIds.length;
    $('deleteRecordingsDialog').showModal();$('cancelDeleteRecordings').focus();
  }
  async function confirmDelete(){
    if(busy||!deleteIds.length)return;
    const ids=deleteIds.slice(),cloud=$('deleteRecordingsCloud').checked;
    busy=true;paint();
    for(const id of ['cancelDeleteRecordings','confirmDeleteRecordings','deleteRecordingsCloud'])$(id).disabled=true;
    try{
      const result=await config.remove(ids,{cloud,onProgress:(done,total)=>{$('deleteRecordingsStatus').textContent='Deleting '+done+' of '+total+'…';}});
      result.done.forEach(id=>selected.delete(String(id)));
      const message=report(result,'deleted');announce(message,result.failed.length>0);
      deleteIds=result.failed.concat(result.skipped).map(item=>String(item.id));
      if(!deleteIds.length)$('deleteRecordingsDialog').close();
      else {$('deleteRecordingsStatus').textContent=message;$('confirmDeleteRecordings').textContent='Retry '+deleteIds.length;}
    }catch(error){$('deleteRecordingsStatus').textContent=error.message||'Could not delete recordings.';}
    finally{
      busy=false;
      for(const id of ['cancelDeleteRecordings','confirmDeleteRecordings'])$(id).disabled=false;
      $('deleteRecordingsCloud').disabled=!root.SynapAuth?.isSignedIn?.();
      await config.refresh();paint();
    }
  }
  function reset(){filter='all';selected.clear();if($('libraryStatusFilter'))$('libraryStatusFilter').value='all';}
  function configure(value){
    config=value;if(installed)return;installed=true;
    const control=$('libraryStatusFilter');
    for(const [key,label] of filters){const option=root.document.createElement('option');option.value=key;option.textContent=label;control.appendChild(option);}
    control.addEventListener('change',()=>{filter=control.value;selected.clear();config.render();});
    $('clearRecordingFilters').addEventListener('click',()=>{reset();config.render();});
    $('selectRecordingsButton').addEventListener('click',()=>{selecting=!selecting;selected.clear();announce('');paint();});
    $('selectAllRecordings').addEventListener('change',event=>{selected.clear();if(event.target.checked)matches.filter(selectable).forEach(r=>selected.add(String(r.id)));paint();});
    $('processSelectedRecordings').addEventListener('click',()=>processIds([...selected]));
    $('deleteSelectedRecordings').addEventListener('click',()=>requestDelete([...selected]));
    $('cancelDeleteRecordings').addEventListener('click',()=>$('deleteRecordingsDialog').close());
    $('confirmDeleteRecordings').addEventListener('click',()=>confirmDelete());
    $('deleteRecordingsDialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    let refreshTimer;
    const refresh=()=>{root.clearTimeout(refreshTimer);refreshTimer=root.setTimeout(()=>config.refresh(),80);};
    const queue=$('queueStatus');
    if(queue)new MutationObserver(refresh).observe(queue,{childList:true,subtree:true,characterData:true});
    root.addEventListener('synap-processing-state',refresh);
    root.addEventListener('synap-memory-ready',refresh);
    $('providerInput')?.addEventListener('change',refresh);
    new MutationObserver(paint).observe(root.document.body,{attributes:true,attributeFilter:['data-state']});
  }
  root.SynapLibraryTools={state,matchesStatus,setJobs,update,decorate,configure,requestDelete,processIds,reset,
    matches:recording=>matchesStatus(recording,filter,jobs.get(String(recording.id))||[],provider()),get filtered(){return filter!=='all';}};
})(globalThis);
