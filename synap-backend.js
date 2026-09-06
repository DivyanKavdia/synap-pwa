/* Synap backend provider.
 *
 * Replaces the browser-side model calls in ai-providers.js. Instead of posting
 * audio to a provider with the user's own API key sitting in this page, the
 * PWA uploads sealed segments to the Synap backend, which holds the Gemini AI
 * Studio key in Secret Manager and writes encrypted memory to GCP.
 *
 * This hooks the same DKFIFOProcessor seams the OpenAI provider uses, so the
 * existing queue keeps its ordering, idempotency keys, retry backoff,
 * per-recording failure isolation and OTA pause. Synap Cloud is a managed
 * transport: its deployment URL comes from SynapAuth configuration and is never
 * copied into the user's Custom endpoint settings during normal app use.
 */
(function (root) {
  'use strict';

  var PREF_KEY = 'synap-ai-provider-settings';
  var SEGMENT_SECONDS = 30;
  var UPLOAD_TIMEOUT_MS = 120000;
  var PROCESSING_TIMEOUT_MS = 900000;
  var POLL_INTERVAL_MS = 5000;

  function prefs() {
    try { return JSON.parse(root.localStorage.getItem(PREF_KEY) || '{}') || {}; }
    catch (error) { return {}; }
  }

  function auth() {
    if (!root.SynapAuth) throw new Error('google-auth.js did not load.');
    return root.SynapAuth;
  }

  function managedEndpoint() {
    var backendUrl = root.SynapAuth && root.SynapAuth.config().backendUrl;
    if (!backendUrl) return '';
    return String(backendUrl).replace(/\/+$/, '') + '/v1/recordings';
  }

  function permanent(message) {
    var error = new Error(message); error.retryable = false; return error;
  }

  function fromResponse(response, data) {
    var message = (data && data.error && data.error.message) || ('HTTP ' + response.status);
    var error = new Error(message); error.status = response.status;
    error.retryable = response.status >= 500 || [408,409,425,429].indexOf(response.status) !== -1;
    return error;
  }

  function request(path, options) {
    var init = options || {};
    return auth().authedFetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null; try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
        if (!response.ok) throw fromResponse(response, data); return data;
      });
    });
  }

  function idempotencyKey(job, suffix) {
    return String(job.dedupe || (job.recordingId + ':' + job.kind)) + ':' + suffix;
  }

  function ensureRecording(processor, recordingId) {
    return processor.store.get('recordings', recordingId).then(function (recording) {
      if (!recording) throw permanent('Recording is no longer in local storage.');
      var startedAt = recording.createdAt || new Date().toISOString();
      var timezone = 'UTC'; try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (error) {}
      return request('/v1/recordings', { method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':'create:'+recordingId}, body:JSON.stringify({recording_id:recordingId,device_id:recording.deviceId||'',started_at:new Date(startedAt).toISOString(),sample_rate:recording.sampleRate||16000,channels:1,encoding:'pcm_s16le',language:prefs().language||'auto',timezone:timezone,continuous_group_id:recording.continuousGroupId||null,continuous_part:Number(recording.continuousPart||1)}) }).then(function(){return recording;});
    });
  }

  function sha256Hex(buffer) {
    if (!root.crypto || !root.crypto.subtle) return Promise.resolve(null);
    return root.crypto.subtle.digest('SHA-256', buffer).then(function (digest) {
      var bytes=new Uint8Array(digest),out=''; for(var index=0;index<bytes.length;index+=1)out+=bytes[index].toString(16).padStart(2,'0'); return out;
    }).catch(function(){return null;});
  }

  function uploadSegment(processor, job) {
    return ensureRecording(processor,job.recordingId).then(function(){return processor.store.segment(job.recordingId,job.segmentIndex);}).then(function(data){
      if(!data.blob&&!data.frames.length)throw permanent('Segment has no complete PCM frames.');
      var wav=data.blob||root.DKAudioCodec.wav(data.frames); return wav.arrayBuffer();
    }).then(function(buffer){return sha256Hex(buffer).then(function(digest){
      var startMs=job.segmentIndex*SEGMENT_SECONDS*1000; var headers={'Content-Type':'audio/wav','X-Synap-Start-Ms':String(startMs),'X-Synap-End-Ms':String(startMs+SEGMENT_SECONDS*1000)}; if(digest)headers['X-Synap-Sha256']=digest;
      return request('/v1/recordings/'+encodeURIComponent(job.recordingId)+'/segments/'+encodeURIComponent(job.segmentIndex),{method:'PUT',headers:headers,body:buffer});
    });}).then(function(){return{transcript:'',uploadedToBackend:true,provider:'synap',uploadedAt:new Date().toISOString()};});
  }

  function uploadHighlights(processor, recordingId) {
    return processor.store.get('recordings',recordingId).then(function(recording){
      var markers=(recording&&(recording.rememberMarkers||recording.highlights))||[]; if(!markers.length)return null;
      return Promise.all(markers.map(function(marker){var id=marker.id||marker.highlightId;if(!id)return Promise.resolve(null);return request('/v1/recordings/'+encodeURIComponent(recordingId)+'/highlights',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({highlight_id:id,offset_ms:Math.max(0,Math.round(Number(marker.offsetMs||marker.offset||0))),created_at:marker.createdAt||new Date().toISOString(),source:marker.source==='pwa'?'pwa':'pendant',note:marker.note||null})}).catch(function(){return null;});})).then(function(){return null;});
    }).catch(function(){return null;});
  }

  function finalize(processor,job){
    return processor.store.get('recordings',job.recordingId).then(function(recording){return processor.store.all('segments','recording',job.recordingId).then(function(segments){var counted=segments.filter(function(segment){return segment.frameCount||segment.pcmBlob;}).length;return request('/v1/recordings/'+encodeURIComponent(job.recordingId)+'/finalize',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':idempotencyKey(job,'finalize')},body:JSON.stringify({ended_at:new Date((recording&&(recording.endedAt||recording.completedAt))||Date.now()).toISOString(),duration_ms:Math.max(0,Math.round(Number((recording&&recording.durationMs)||0))),segment_count:counted||segments.length})});});});
  }

  function waitForProcessing(processor,job,onProgress){
    var deadline=Date.now()+PROCESSING_TIMEOUT_MS;
    function poll(){
      if(processor.paused||!processor.canRun()){var aborted=new Error('Processing paused');aborted.name='AbortError';throw aborted;}
      if(Date.now()>deadline){var slow=new Error('The backend is still working on this recording.');slow.retryable=true;throw slow;}
      return request('/v1/recordings/'+encodeURIComponent(job.recordingId)+'/processing').then(function(status){if(onProgress)onProgress(status);if(status.state==='ready')return status;if(status.state==='failed'){var failure=new Error(status.error_code||'Backend processing failed.');failure.retryable=Boolean(status.retryable);throw failure;}return new Promise(function(resolve){setTimeout(resolve,POLL_INTERVAL_MS);}).then(poll);});
    }
    return poll();
  }

  function toRecordingFields(memory){
    var actions=[],followUps=[],decisions=[];
    (memory.conversations||[]).forEach(function(conversation){(conversation.decisions||[]).forEach(function(decision){decisions.push(decision.text);});(conversation.action_items||[]).forEach(function(action){actions.push({task:action.task,owner:action.owner,due_date:action.due_date||''});});(conversation.follow_ups||[]).forEach(function(item){followUps.push(item.text);});});
    var lines=[memory.executive_summary||''];function section(title,values){if(!values||!values.length)return;lines.push('',title);values.forEach(function(value){lines.push('• '+value);});}
    section('Key points',memory.key_points);section('Decisions',decisions);if(actions.length){lines.push('','Action items');actions.forEach(function(action){lines.push('• '+action.task+(action.owner?' — '+action.owner:'')+(action.due_date?' · '+action.due_date:''));});}section('Follow-ups',followUps);
    return{name:memory.title||undefined,summary:lines.join('\n').trim(),meeting:memory,people:memory.people||[],conversations:memory.conversations||[],processingState:'done',provider:'synap',processedAt:new Date().toISOString()};
  }

  function consolidate(processor,job){
    return uploadHighlights(processor,job.recordingId).then(function(){return finalize(processor,job);}).then(function(){return waitForProcessing(processor,job,function(status){var percent=Math.round((Number(status.progress)||0)*100);processor.onChange('Synap is understanding this conversation · '+percent+'%');});}).then(function(){return request('/v1/recordings/'+encodeURIComponent(job.recordingId)+'/memory');}).then(function(memory){var fields=toRecordingFields(memory);if(typeof memory.transcript==='string')fields.transcript=memory.transcript;return fields;});
  }

  function handle(processor,job){
    if(job.kind==='transcribe')return uploadSegment(processor,job);
    if(job.kind==='summarize')return Promise.resolve({summary:'',contextReady:true,provider:'synap'});
    return consolidate(processor,job);
  }

  function patch(){
    var Processor=root.DKFIFOProcessor;if(!Processor||Processor.prototype.__synapBackendPatched)return;
    var originalProcess=Processor.prototype.process,originalRun=Processor.prototype.run;

    Processor.prototype.run=function(){
      if(prefs().provider!=='synap')return originalRun.call(this);
      if(!root.SynapAuth||!root.SynapAuth.isSignedIn()){this.onChange('Sign in with Google to process pending memories.');return Promise.resolve();}
      var endpoint=managedEndpoint();if(!endpoint){this.onChange('Synap Cloud is not configured for this build.');return Promise.resolve();}
      var originalSettings=this.settings,self=this;this.settings=function(){var config=originalSettings?originalSettings():{};return Object.assign({},config,{endpoint:endpoint,llmEndpoint:endpoint});};
      var outcome;try{outcome=originalRun.call(this);}catch(error){this.settings=originalSettings;throw error;}
      return Promise.resolve(outcome).then(function(value){self.settings=originalSettings;return value;},function(error){self.settings=originalSettings;throw error;});
    };

    Processor.prototype.process=function(job,config,url){
      var settings=prefs();if(settings.provider!=='synap')return originalProcess.call(this,job,config,url);
      if(!root.SynapAuth||!root.SynapAuth.isSignedIn())return Promise.reject(permanent('Sign in with Google in Settings to sync your memories.'));
      var self=this,controller=new AbortController();this.controllers.set(job.id,controller);var budget=job.kind==='consolidate'?PROCESSING_TIMEOUT_MS:UPLOAD_TIMEOUT_MS;var timer=setTimeout(function(){controller.abort();},budget);
      return handle(this,job).then(function(result){clearTimeout(timer);self.controllers.delete(job.id);return result;},function(error){clearTimeout(timer);self.controllers.delete(job.id);throw error;});
    };
    Processor.prototype.__synapBackendPatched=true;
  }

  /* Explicit migration helper retained for old self-host tooling/tests only.
     Production startup, login and provider switching never call this method. */
  function mirrorEndpoints(){
    if(prefs().provider!=='synap')return;
    var endpoint=managedEndpoint();if(!endpoint)return;
    try{var stored=JSON.parse(root.localStorage.getItem('dk-pendant-settings')||'{}');stored.endpoint=endpoint;stored.llmEndpoint=endpoint;root.localStorage.setItem('dk-pendant-settings',JSON.stringify(stored));}catch(error){}
  }

  patch();
  if(root.document&&root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',patch,{once:true});

  root.SynapBackend={patchProcessor:patch,mirrorEndpoints:mirrorEndpoints,toRecordingFields:toRecordingFields,
    ask:function(query,scope){return request('/v1/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:query,scope:scope||{}})});},
    dailyBrief:function(day){return request('/v1/days/'+encodeURIComponent(day)+'/brief');},
    people:function(){return request('/v1/people');},
    followUps:function(state,owner){return request('/v1/follow-ups?state='+encodeURIComponent(state||'open')+'&owner='+encodeURIComponent(owner||'all'));},
    resolveFollowUp:function(id,state){return request('/v1/follow-ups/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:state})});},
    confirmPerson:function(personId,confirmed){return request('/v1/people/'+encodeURIComponent(personId),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:confirmed!==false})});}
  };
})(globalThis);
