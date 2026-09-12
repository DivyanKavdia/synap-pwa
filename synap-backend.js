/* Synap backend provider.
 *
 * The PWA uploads sealed recording segments to Synap Cloud and keeps the local
 * durable FIFO as the single processing authority. Every network operation and
 * every FIFO job is bounded: a lost request becomes a retryable failure instead
 * of leaving a recording permanently marked running.
 */
(function (root) {
  'use strict';

  var PREF_KEY = 'synap-ai-provider-settings';
  var SEGMENT_SECONDS = 30;
  var UPLOAD_TIMEOUT_MS = 120000;
  var REQUEST_TIMEOUT_MS = 60000;
  var STATUS_REQUEST_TIMEOUT_MS = 30000;
  var PROCESSING_TIMEOUT_MS = 900000;
  var POLL_INTERVAL_MS = 5000;

  function prefs() {
    try { return JSON.parse(root.localStorage.getItem(PREF_KEY) || '{}') || {}; }
    catch (_) { return {}; }
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
    var error = new Error(message);
    error.retryable = false;
    return error;
  }

  function fromResponse(response, data) {
    var message = (data && data.error && data.error.message) || ('HTTP ' + response.status);
    var error = new Error(message);
    error.status = response.status;
    error.retryable = response.status >= 500 || [408, 409, 425, 429].indexOf(response.status) !== -1;
    return error;
  }

  function requestBudget(path, init) {
    if (String(path).indexOf('/processing') !== -1) return STATUS_REQUEST_TIMEOUT_MS;
    if (String(init && init.method || '').toUpperCase() === 'PUT' && String(path).indexOf('/segments/') !== -1) {
      return UPLOAD_TIMEOUT_MS;
    }
    return REQUEST_TIMEOUT_MS;
  }

  function parseResponse(response) {
    return response.text().then(function (text) {
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
      if (!response.ok) throw fromResponse(response, data);
      return data;
    });
  }

  function request(path, options) {
    var init = Object.assign({}, options || {});
    var Controller = root.AbortController;
    if (typeof Controller !== 'function') return auth().authedFetch(path, init).then(parseResponse);

    var controller = new Controller();
    var upstream = init.signal;
    var timedOut = false;
    var timeout = requestBudget(path, init);
    var onUpstreamAbort = function () { controller.abort(); };
    if (upstream) {
      if (upstream.aborted) controller.abort();
      else if (typeof upstream.addEventListener === 'function') upstream.addEventListener('abort', onUpstreamAbort, { once: true });
    }
    init.signal = controller.signal;
    var timer = root.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeout);

    return auth().authedFetch(path, init)
      .then(parseResponse)
      .catch(function (error) {
        if (!timedOut) throw error;
        var timeoutError = new Error('Synap request timed out. Processing will retry safely.');
        timeoutError.name = 'TimeoutError';
        timeoutError.retryable = true;
        throw timeoutError;
      })
      .finally(function () {
        root.clearTimeout(timer);
        if (upstream && typeof upstream.removeEventListener === 'function') upstream.removeEventListener('abort', onUpstreamAbort);
      });
  }

  function abortableDelay(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        var early = new Error('Processing paused'); early.name = 'AbortError'; reject(early); return;
      }
      var timer = root.setTimeout(done, ms);
      function done() {
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', aborted);
        resolve();
      }
      function aborted() {
        root.clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', aborted);
        var error = new Error('Processing paused'); error.name = 'AbortError'; reject(error);
      }
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', aborted, { once: true });
    });
  }

  function idempotencyKey(job, suffix) {
    return String(job.dedupe || (job.recordingId + ':' + job.kind)) + ':' + suffix;
  }

  function userRetryKey(recordingId) {
    var nonce = root.crypto && typeof root.crypto.randomUUID === 'function'
      ? root.crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    return 'retry:' + recordingId + ':' + nonce;
  }

  function stableFinalizeEndedAt(recording) {
    var explicit = recording && (recording.endedAt || recording.completedAt);
    if (explicit) {
      var explicitDate = new Date(explicit);
      if (!Number.isNaN(explicitDate.getTime())) return explicitDate.toISOString();
    }
    var started = new Date(recording && recording.createdAt);
    if (Number.isNaN(started.getTime())) throw permanent('Recording start time is missing; cannot finalize safely.');
    var duration = Math.max(0, Math.round(Number(recording && recording.durationMs) || 0));
    return new Date(started.getTime() + duration).toISOString();
  }

  function segmentBounds(recording, segmentIndex) {
    var startMs = Math.max(0, Number(segmentIndex) || 0) * SEGMENT_SECONDS * 1000;
    var fullEndMs = startMs + SEGMENT_SECONDS * 1000;
    var durationMs = Math.max(0, Math.round(Number(recording && recording.durationMs) || 0));
    var sealed = Boolean(recording && recording.sealed && recording.status !== 'recording');
    var endMs = sealed && durationMs > startMs ? Math.min(fullEndMs, durationMs) : fullEndMs;
    if (endMs <= startMs) endMs = fullEndMs;
    return { startMs: startMs, endMs: endMs };
  }

  function patchLocalProcessing(processor, recordingId, fields) {
    if (!processor || !processor.store || typeof processor.store.atomic !== 'function') return Promise.resolve();
    return processor.store.atomic(['recordings'], function (stores) {
      var get = stores.recordings.get(recordingId);
      get.onsuccess = function () {
        if (!get.result) return;
        stores.recordings.put(Object.assign({}, get.result, fields, { processingUpdatedAt: new Date().toISOString() }));
      };
    });
  }

  function safePatchLocalProcessing(processor, recordingId, fields) {
    return patchLocalProcessing(processor, recordingId, fields).catch(function () { return null; });
  }

  var createdRecordings = Object.create(null);

  function ensureRecording(processor, recordingId, signal) {
    if (createdRecordings[recordingId]) return createdRecordings[recordingId];
    var pending = createRecording(processor, recordingId, signal);
    createdRecordings[recordingId] = pending;
    pending.catch(function () { delete createdRecordings[recordingId]; });
    return pending;
  }

  function createRecording(processor, recordingId, signal) {
    return processor.store.get('recordings', recordingId).then(function (recording) {
      if (!recording) throw permanent('Recording is no longer in local storage.');
      var startedAt = recording.createdAt || new Date().toISOString();
      var timezone = 'UTC';
      try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) {}
      return request('/v1/recordings', {
        method: 'POST', signal: signal,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'create:' + recordingId },
        body: JSON.stringify({
          recording_id: recordingId,
          device_id: recording.deviceId || '',
          started_at: new Date(startedAt).toISOString(),
          sample_rate: recording.sampleRate || 16000,
          channels: 1,
          encoding: 'pcm_s16le',
          language: prefs().language || 'auto',
          timezone: timezone,
          continuous_group_id: recording.continuousGroupId || null,
          continuous_part: Number(recording.continuousPart || 1)
        })
      }).then(function () { return recording; });
    });
  }

  function sha256Hex(buffer) {
    if (!root.crypto || !root.crypto.subtle) return Promise.resolve(null);
    return root.crypto.subtle.digest('SHA-256', buffer).then(function (digest) {
      var bytes = new Uint8Array(digest), out = '';
      for (var index = 0; index < bytes.length; index += 1) out += bytes[index].toString(16).padStart(2, '0');
      return out;
    }).catch(function () { return null; });
  }

  async function transcriptionAudio(store,job,original,signal) {
    const key=[job.recordingId,job.segmentIndex],meta=await store.get('segments',key);
    if(meta?.transcriptionBlob)return meta.transcriptionBlob;
    if(!meta || meta.uploadedToBackend || !store.atomic || !root.SynapAudioEnhancement?.prepareForUpload)return original;
    const copy=await root.SynapAudioEnhancement.prepareForUpload(original,{signal});
    if(signal?.aborted)throw new DOMException('Upload cancelled.','AbortError');
    // Persist the exact request body before sending it: retries after a reload
    // must keep the same digest even when the Worker previously fell back.
    return store.atomic(['segments'],function(stores,result,transaction){
      const get=stores.segments.get(key);
      get.onsuccess=function(){
        if(!get.result){transaction.abort();return;}
        const selected=get.result.transcriptionBlob||copy;
        stores.segments.put({...get.result,transcriptionBlob:selected});result(selected);
      };
    });
  }

  async function uploadSegment(processor, job, signal) {
    if((await processor.store.get('segments',[job.recordingId,job.segmentIndex]))?.uploadedToBackend)
      return {transcript:'',uploadedToBackend:true,provider:'synap'};
    var recording = null;
    return safePatchLocalProcessing(processor, job.recordingId, {
      processingStage: 'uploading', processingError: '', processingRetryable: true
    }).then(function () {
      return ensureRecording(processor, job.recordingId, signal);
    }).then(function () {
      return Promise.all([
        processor.store.segment(job.recordingId, job.segmentIndex),
        processor.store.get('recordings', job.recordingId)
      ]);
    }).then(function (values) {
      var data = values[0]; recording = values[1];
      if (!data.blob && !data.frames.length) throw permanent('Segment has no complete PCM frames.');
      var wav = data.blob || root.DKAudioCodec.wav(data.frames);
      return transcriptionAudio(processor.store,job,wav,signal).then(function(copy){return copy.arrayBuffer()});
    }).then(function (buffer) {
      return sha256Hex(buffer).then(function (digest) {
        var bounds = segmentBounds(recording, job.segmentIndex);
        var headers = {
          'Content-Type': 'audio/wav',
          'X-Synap-Start-Ms': String(bounds.startMs),
          'X-Synap-End-Ms': String(bounds.endMs)
        };
        if (digest) headers['X-Synap-Sha256'] = digest;
        return request('/v1/recordings/' + encodeURIComponent(job.recordingId) + '/segments/' + encodeURIComponent(job.segmentIndex), {
          method: 'PUT', headers: headers, body: buffer, signal: signal
        });
      });
    }).then(async function () {
      if(processor.store.atomic)await processor.store.atomic(['segments'],function(stores){
        const get=stores.segments.get([job.recordingId,job.segmentIndex]);
        get.onsuccess=function(){if(get.result){const meta={...get.result,uploadedToBackend:true};delete meta.transcriptionBlob;stores.segments.put(meta)}};
      });
      return { transcript: '', uploadedToBackend: true, provider: 'synap', uploadedAt: new Date().toISOString() };
    });
  }

  function uploadHighlights(processor, recordingId, signal) {
    return processor.store.get('recordings', recordingId).then(function (recording) {
      var markers = recording ? (root.SynapMoments?.markers(recording) || recording.rememberMarkers || recording.highlights || []) : [];
      if (!markers.length) return null;
      return markers.reduce(function (pending, marker) { return pending.then(function () {
        var id = marker.id || marker.highlightId;
        if (!id) return Promise.resolve(null);
        return request('/v1/recordings/' + encodeURIComponent(recordingId) + '/highlights', {
          method: 'POST', signal: signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            highlight_id: id,
            offset_ms: Math.max(0, Math.round(Number(marker.offsetMs || marker.offset || 0))),
            created_at: marker.createdAt || new Date().toISOString(),
            source: marker.source === 'pwa' ? 'pwa' : 'pendant',
            note: marker.note || null
          })
        });
      }); }, Promise.resolve());
    });
  }

  function finalize(processor, job, signal) {
    return processor.store.get('recordings', job.recordingId).then(function (recording) {
      return processor.store.all('segments', 'recording', job.recordingId).then(function (segments) {
        var counted = segments.filter(function (segment) { return segment.frameCount || segment.pcmBlob; }).length;
        return request('/v1/recordings/' + encodeURIComponent(job.recordingId) + '/finalize', {
          method: 'POST', signal: signal,
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey(job, 'finalize-v2') },
          body: JSON.stringify({
            ended_at: stableFinalizeEndedAt(recording),
            duration_ms: Math.max(0, Math.round(Number((recording && recording.durationMs) || 0))),
            segment_count: counted || segments.length
          })
        }).then(function (result) {
          return safePatchLocalProcessing(processor, job.recordingId, {
            processingStage: 'uploaded', processingProgress: 0,
            processingFailedStage: '', processingError: '', processingRetryable: true
          }).then(function () { return result; });
        });
      });
    });
  }

  function waitForProcessing(processor, job, onProgress, signal) {
    var deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    var lastBackendStage = 'uploaded';
    function poll() {
      if ((signal && signal.aborted) || processor.paused || !processor.canRun()) {
        var aborted = new Error('Processing paused'); aborted.name = 'AbortError'; throw aborted;
      }
      if (Date.now() > deadline) {
        var slow = new Error('The backend is still working on this recording.'); slow.retryable = true; throw slow;
      }
      return request('/v1/recordings/' + encodeURIComponent(job.recordingId) + '/processing', { signal: signal }).then(function (status) {
        var state = String(status && status.state || '');
        var progress = Number(status && status.progress);
        var fields = {
          processingStage: state || lastBackendStage,
          processingProgress: Number.isFinite(progress) ? progress : null,
          processingError: (status && status.error_code) || '',
          processingRetryable: Boolean(status && status.retryable)
        };
        if (state === 'failed') fields.processingFailedStage = lastBackendStage;
        else if (state) { lastBackendStage = state; fields.processingFailedStage = ''; }
        return safePatchLocalProcessing(processor, job.recordingId, fields).then(function () {
          if (onProgress) onProgress(status);
          if (state === 'ready') return status;
          if (state === 'failed') {
            var failure = new Error(status.error_code || 'Backend processing failed.');
            failure.retryable = Boolean(status.retryable);
            throw failure;
          }
          return abortableDelay(POLL_INTERVAL_MS, signal).then(poll);
        });
      });
    }
    return poll();
  }

  function toRecordingFields(memory) {
    var actions = [], followUps = [], decisions = [];
    (memory.conversations || []).forEach(function (conversation) {
      (conversation.decisions || []).forEach(function (decision) { decisions.push(decision.text); });
      (conversation.action_items || []).forEach(function (action) { actions.push({ task: action.task, owner: action.owner, due_date: action.due_date || '' }); });
      (conversation.follow_ups || []).forEach(function (item) { followUps.push(item.text); });
    });
    var lines = [memory.executive_summary || ''];
    function section(title, values) {
      if (!values || !values.length) return;
      lines.push('', title);
      values.forEach(function (value) { lines.push('• ' + value); });
    }
    section('Key points', memory.key_points);
    section('Decisions', decisions);
    if (actions.length) {
      lines.push('', 'Action items');
      actions.forEach(function (action) { lines.push('• ' + action.task + (action.owner ? ' — ' + action.owner : '') + (action.due_date ? ' · ' + action.due_date : '')); });
    }
    section('Follow-ups', followUps);
    return {
      name: memory.title || undefined,
      summary: lines.join('\n').trim(),
      meeting: memory,
      ...(memory.speaker_names ? { speakerNames: memory.speaker_names } : {}),
      ...(typeof memory.raw_transcript === 'string' ? { rawTranscript: memory.raw_transcript } : {}),
      people: memory.people || [],
      conversations: memory.conversations || [],
      processingState: 'done', processingStage: 'ready', processingProgress: 1,
      processingFailedStage: '', processingError: '', processingRetryable: false,
      provider: 'synap', processedAt: new Date().toISOString()
    };
  }

  function consolidate(processor, job, signal) {
    return uploadHighlights(processor, job.recordingId, signal)
      .then(function () { return finalize(processor, job, signal); })
      .then(function () {
        return waitForProcessing(processor, job, function (status) {
          var percent = Math.round((Number(status.progress) || 0) * 100);
          processor.onChange('Synap is understanding this conversation · ' + percent + '%');
        }, signal);
      })
      .then(function () { return request('/v1/recordings/' + encodeURIComponent(job.recordingId) + '/memory', { signal: signal }); })
      .then(function (memory) {
        var fields = toRecordingFields(memory);
        if (typeof memory.transcript === 'string') fields.transcript = memory.transcript;
        return fields;
      });
  }

  function handle(processor, job, signal) {
    if (job.kind === 'transcribe') return uploadSegment(processor, job, signal);
    if (job.kind === 'summarize') return Promise.resolve({ summary: '', contextReady: true, provider: 'synap' });
    return consolidate(processor, job, signal);
  }

  function recoverLegacyFinalizeFailures(processor) {
    if (!processor || !processor.store || typeof processor.store.all !== 'function' || typeof processor.store.patchJob !== 'function') return Promise.resolve();
    return processor.store.all('jobs').then(function (jobs) {
      var legacy = (jobs || []).filter(function (job) {
        return job && job.kind === 'consolidate' && job.state === 'failed' && String(job.lastError || '').indexOf('Idempotency-Key reused with a different request body') !== -1;
      });
      return Promise.all(legacy.map(function (job) {
        return processor.store.patchJob(job.id, { state: 'pending', attempts: 0, nextAt: 0, lastError: '' });
      }));
    }).catch(function () { return null; });
  }

  function patch() {
    var Processor = root.DKFIFOProcessor;
    if (!Processor || Processor.prototype.__synapBackendPatched) return;
    var originalProcess = Processor.prototype.process, originalRun = Processor.prototype.run;

    Processor.prototype.run = function () {
      if (prefs().provider !== 'synap') return originalRun.call(this);
      if (!root.SynapAuth || !root.SynapAuth.isSignedIn()) {
        this.onChange('Sign in with Google to process pending memories.'); return Promise.resolve();
      }
      var endpoint = managedEndpoint();
      if (!endpoint) { this.onChange('Synap Cloud is not configured for this build.'); return Promise.resolve(); }
      if (!this.__synapFinalizeRecoveryDone) {
        this.__synapFinalizeRecoveryDone = true;
        var recoveryProcessor = this;
        return recoverLegacyFinalizeFailures(this).then(function () { return recoveryProcessor.run(); });
      }
      var originalSettings = this.settings, self = this;
      this.settings = function () {
        var config = originalSettings ? originalSettings() : {};
        return Object.assign({}, config, { endpoint: endpoint, llmEndpoint: endpoint });
      };
      var outcome;
      try { outcome = originalRun.call(this); }
      catch (error) { this.settings = originalSettings; throw error; }
      return Promise.resolve(outcome).then(function (value) { self.settings = originalSettings; return value; }, function (error) { self.settings = originalSettings; throw error; });
    };

    Processor.prototype.process = function (job, config, url) {
      if (prefs().provider !== 'synap') return originalProcess.call(this, job, config, url);
      if (!root.SynapAuth || !root.SynapAuth.isSignedIn()) return Promise.reject(permanent('Sign in with Google in Settings to sync your memories.'));
      var Controller = root.AbortController;
      if (typeof Controller !== 'function') return handle(this, job, null);
      var self = this, controller = new Controller();
      this.controllers.set(job.id, controller);
      var budget = job.kind === 'consolidate' ? PROCESSING_TIMEOUT_MS : UPLOAD_TIMEOUT_MS;
      var timer = root.setTimeout(function () { controller.abort(); }, budget);
      return handle(this, job, controller.signal).then(function (result) {
        root.clearTimeout(timer); self.controllers.delete(job.id); return result;
      }, function (error) {
        root.clearTimeout(timer); self.controllers.delete(job.id); throw error;
      });
    };
    Processor.prototype.__synapBackendPatched = true;
  }

  // Kept only as a backward-compatible API for older installed shells. Current
  // production run() injects managed endpoints transiently and never calls this.
  function mirrorEndpoints() {
    if (prefs().provider !== 'synap') return;
    var endpoint = managedEndpoint();
    if (!endpoint) return;
    try {
      var stored = JSON.parse(root.localStorage.getItem('dk-pendant-settings') || '{}');
      stored.endpoint = endpoint; stored.llmEndpoint = endpoint;
      root.localStorage.setItem('dk-pendant-settings', JSON.stringify(stored));
    } catch (_) {}
  }

  patch();
  if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', patch, { once: true });

  root.SynapBackend = {
    patchProcessor:patch,
    mirrorEndpoints:mirrorEndpoints,
    toRecordingFields:toRecordingFields,
    segmentBounds:segmentBounds,
    transcriptionAudio:transcriptionAudio,
    requestBudget:requestBudget,
    ask:function(query,scope){return request('/v1/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:query,scope:scope||{}})});},
    dailyBrief:function(day){return request('/v1/days/'+encodeURIComponent(day)+'/brief');},
    people:function(){return request('/v1/people');},
    retryRecording:function(recordingId){var id=String(recordingId||'');if(!id)return Promise.reject(permanent('Recording id is required.'));return request('/v1/recordings/'+encodeURIComponent(id)+'/retry',{method:'POST',headers:{'Idempotency-Key':userRetryKey(id)}});},
    recordings:function(options){var opts=options||{},query=[];if(opts.day)query.push('day='+encodeURIComponent(opts.day));if(opts.limit)query.push('limit='+encodeURIComponent(opts.limit));if(opts.transcript)query.push('include_transcript=true');return request('/v1/recordings'+(query.length?'?'+query.join('&'):''));},
    followUps:function(state,owner){return request('/v1/follow-ups?state='+encodeURIComponent(state||'open')+'&owner='+encodeURIComponent(owner||'all'));},
    resolveFollowUp:function(id,state){return request('/v1/follow-ups/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:state})});},
    confirmPerson:function(personId,confirmed){return request('/v1/people/'+encodeURIComponent(personId),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:confirmed!==false})});},
    renamePerson:function(personId,name){return request('/v1/people/'+encodeURIComponent(personId),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:String(name||'').trim()})});}
  };
})(globalThis);
