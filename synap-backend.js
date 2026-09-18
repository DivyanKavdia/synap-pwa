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
  const accountScopes = new WeakMap();
  const accountUid = () => String(root.SynapAuth?.session?.()?.profile?.uid || '');

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

  function isManagedEndpoint(value) {
    try {
      const target = new URL(value), base = new URL(root.SynapAuth?.config().backendUrl);
      const productionOrigins = [
        'https://synap-backend-435475937223.asia-south1.run.app',
        'https://synap-backend-idnycfpyqq-el.a.run.app',
      ];
      const sameService = target.origin === base.origin ||
        (productionOrigins.includes(base.origin) && productionOrigins.includes(target.origin));
      const prefix = base.pathname.replace(/\/+$/, '');
      return target.protocol === 'https:' && !target.username && !target.password && sameService &&
        (target.pathname.replace(/\/+$/, '') === prefix || target.pathname === prefix + '/v1' ||
          target.pathname.startsWith(prefix + '/v1/'));
    } catch (_) { return false; }
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
    error.code = data?.error?.code || 'http_error';
    for (const key of ['model', 'modelStage', 'source', 'quotaKind'])
      if (data?.error?.[key] !== undefined) error[key] = data.error[key];
    if (Number.isInteger(data?.error?.providerStatus)) error.providerStatus = data.error.providerStatus;
    const retryHeader = response.headers?.get?.('retry-after');
    const headerDelay = retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader.trim())
      ? Number(retryHeader) * 1000 : retryHeader ? Date.parse(retryHeader) - Date.now() : 0;
    const bodyDelay = Number(data?.error?.retryAfterMs);
    const delay = Math.max(Number.isFinite(bodyDelay) ? bodyDelay : 0, Number.isFinite(headerDelay) ? headerDelay : 0);
    if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = Math.min(604800000, Math.ceil(delay));
    error.retryable = typeof data?.error?.retryable === 'boolean'
      ? data.error.retryable
      : response.status >= 500 || [408, 409, 425, 429].indexOf(response.status) !== -1;
    return error;
  }

  function requestBudget(path, init) {
    if (/^\/v1\/(people|follow-ups)(\/|\?|$)/.test(String(path))) return 15000;
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
    var expectedUid = init.signal && accountScopes.get(init.signal);
    if (expectedUid) {
      if (accountUid() !== expectedUid || init.signal.aborted) return Promise.reject(permanent('Google account changed. Retry under the recording owner.'));
      init.expectedUid = expectedUid;
    }
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

    var rejectAbort;
    var aborted = new Promise(function (_, reject) {
      rejectAbort = function () { var error = new Error('Synap request cancelled.'); error.name = 'AbortError'; reject(error); };
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    // Token refresh and some native network bridges may not settle on abort.
    // Release the UI/queue at its deadline even if that older request hangs.
    return Promise.race([Promise.resolve().then(function () { return auth().authedFetch(path, init); }).then(parseResponse), aborted])
      .catch(function (error) {
        if (!timedOut) throw error;
        var timeoutError = new Error(/^\/v1\/(people|follow-ups)(\/|\?|$)/.test(String(path))
          ? 'This request timed out. Please retry.' : 'Synap request timed out. Processing will retry safely.');
        timeoutError.name = 'TimeoutError';
        timeoutError.retryable = true;
        throw timeoutError;
      })
      .finally(function () {
        root.clearTimeout(timer);
        controller.signal.removeEventListener('abort', rejectAbort);
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
    const key = accountUid() + ':' + recordingId;
    if (createdRecordings[key]) return createdRecordings[key];
    var pending = createRecording(processor, recordingId, signal);
    createdRecordings[key] = pending;
    pending.catch(function () { delete createdRecordings[key]; });
    return pending;
  }

  function createRecording(processor, recordingId, signal) {
    return processor.store.get('recordings', recordingId).then(function (recording) {
      if (!recording) throw permanent('Recording is no longer in local storage.');
      if (recording.localOnly) throw permanent('This soundtrack stays on this device.');
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
    if(signal?.aborted)throw new DOMException('Upload cancelled.','AbortError');
    const key=[job.recordingId,job.segmentIndex],meta=await store.get('segments',key);
    const validate=root.DKAudioCodec?.validateWav;
    if(!validate)throw permanent('Audio validation did not load. Reopen Synap online, then retry.');
    if(meta?.transcriptionBlob){await validate(meta.transcriptionBlob);return meta.transcriptionBlob;}
    await validate(original);
    if(!meta || meta.uploadedToBackend || !store.atomic)return original;
    // New requests always use the saved source. A pre-upgrade cached body may
    // already be accepted remotely: keep it unchanged for idempotent retries.
    if(signal?.aborted)throw new DOMException('Upload cancelled.','AbortError');
    // Persist the exact request body before sending it: retries after a reload
    // must keep the same digest even if capture or app versions have changed.
    const selected=await store.atomic(['segments'],function(stores,result,transaction){
      const get=stores.segments.get(key);
      get.onsuccess=function(){
        if(!get.result){transaction.abort();return;}
        const selected=get.result.transcriptionBlob||original;
        const policy=get.result.transcriptionBlob
          ? (get.result.transcriptionAudioPolicy||'legacy-prepared') : 'source-pcm-v1';
        stores.segments.put({...get.result,transcriptionBlob:selected,transcriptionAudioPolicy:policy});result(selected);
      };
    });
    await validate(selected);
    return selected;
  }

  async function uploadSegment(processor, job, signal) {
    const savedSegment = await processor.store.get('segments', [job.recordingId, job.segmentIndex]);
    if (savedSegment?.uploadedToBackend)
      return { transcript: savedSegment.transcript || '', transcriptionOutcome: savedSegment.transcriptionOutcome, uploadedToBackend: true, provider: 'synap' };
    var recording = null;
    let audioStage = 'registering recording';
    return safePatchLocalProcessing(processor, job.recordingId, {
      processingStage: 'uploading', processingError: '', processingRetryable: true, processingRetryAt: 0
    }).then(function () {
      audioStage = 'reading saved segment';
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
      audioStage = 'validating upload audio';
      return transcriptionAudio(processor.store,job,wav,signal).then(function(copy){
        audioStage = 'reading upload bytes';
        return root.DKAudioCodec.readBlob(copy);
      });
    }).then(function (buffer) {
      return sha256Hex(buffer).then(function (digest) {
        var bounds = segmentBounds(recording, job.segmentIndex);
        var headers = {
          'Content-Type': 'audio/wav',
          'X-Synap-Start-Ms': String(bounds.startMs),
          'X-Synap-End-Ms': String(bounds.endMs)
        };
        if (digest) headers['X-Synap-Sha256'] = digest;
        audioStage = 'sending upload';
        return request('/v1/recordings/' + encodeURIComponent(job.recordingId) + '/segments/' + encodeURIComponent(job.segmentIndex) + '?transcription=deferred', {
          method: 'PUT', headers: headers, body: buffer, signal: signal
        });
      });
    }).then(async function (response) {
      audioStage = 'saving upload result';
      const transcript = typeof response?.transcript === 'string' ? response.transcript : '';
      const outcome = response?.transcription_outcome || (transcript.trim() ? 'speech' : 'pending');
      if (processor.store.atomic) await processor.store.atomic(['segments', 'recordings'], function(stores) {
        const get = stores.segments.get([job.recordingId, job.segmentIndex]);
        get.onsuccess = function() {
          if (!get.result) return;
          const meta = { ...get.result, uploadedToBackend: true, transcript, transcriptionOutcome: outcome,
            ...(response?.transcription_audio ? { transcriptionAudioUsage: response.transcription_audio } : {}) };
          delete meta.transcriptionBlob;
          stores.segments.put(meta);
          const segments = stores.segments.index('recording').getAll(job.recordingId);
          segments.onsuccess = function() {
            const getRecording = stores.recordings.get(job.recordingId);
            getRecording.onsuccess = function() {
              const current = getRecording.result;
              if (!current || current.localOnly) return;
              const windows = segments.result.sort((a, b) => a.index - b.index);
              const transcriptionAudioUsage = windows.reduce((sum, segment) => {
                const usage = segment.transcriptionAudioUsage;
                if (!usage) return sum;
                sum.windows++;
                for (const key of ['sourceDurationMs','preparedDurationMs','submittedAudioMs','requestAttempts'])
                  sum[key] += Math.max(0, Number(usage[key]) || 0);
                if (usage.speed === 1.5) sum.acceleratedWindows++;
                if (usage.fallback) sum.fallbackWindows++;
                return sum;
              }, { windows:0, acceleratedWindows:0, fallbackWindows:0, sourceDurationMs:0,
                preparedDurationMs:0, submittedAudioMs:0, requestAttempts:0 });
              if (current.transcriptComplete || current.processingStage === 'ready') {
                stores.recordings.put({ ...current, transcriptionAudioUsage }); return;
              }
              const text = windows.map(segment => segment.transcript || '').filter(Boolean).join('\n');
              stores.recordings.put({ ...current, transcriptionAudioUsage, transcript: text || current.transcript || '',
                transcriptComplete: false,
                transcriptSegments: windows.filter(segment => segment.uploadedToBackend && segment.transcriptionOutcome !== 'pending').length });
            };
          };
        };
      });
      return { transcript, transcriptionOutcome: outcome, uploadedToBackend: true, provider: 'synap', uploadedAt: new Date().toISOString() };
    }).catch(function (error) {
      error.audioStage = audioStage === 'sending upload' && String(error.code || '').startsWith('model_')
        ? 'transcribing saved audio' : audioStage;
      throw error;
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
        var counted = segments.filter(function (segment) { return segment.frameCount || segment.pcmBuffer || segment.pcmBlob; }).length;
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
            processingFailedStage: '', processingError: '', processingRetryable: true, processingRetryAt: 0
          }).then(function () { return result; });
        });
      });
    });
  }

  function waitForProcessing(processor, job, onProgress, signal) {
    var deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    var lastBackendStage = 'uploaded';
    var recoveryRequested = false;
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
        var detail = status && status.error || {};
        var retryAt = Number(detail.retryAt || 0);
        if (!(retryAt > Date.now()) && Number(detail.retryAfterMs) > 0)
          retryAt = Date.now() + Number(detail.retryAfterMs);
        var fields = {
          processingStage: state || lastBackendStage,
          processingProgress: Number.isFinite(progress) ? progress : null,
          processingError: (status && status.error_code) || '',
          processingRetryable: Boolean(status && status.retryable),
          processingRetryAt: state === 'failed' && retryAt > Date.now() ? retryAt : 0
        };
        if (state === 'failed') fields.processingFailedStage = lastBackendStage;
        else if (state) { lastBackendStage = state; fields.processingFailedStage = ''; }
        return safePatchLocalProcessing(processor, job.recordingId, fields).then(function () {
          if (onProgress) onProgress(status);
          if (state === 'ready') return status;
          if (state === 'failed') {
            processor.diagnostic?.('Cloud processing failure', {
              recordingId: job.recordingId, jobId: job.id, failureId: status.failure_id || null,
              code: detail.code || null, source: detail.source || 'unknown',
              model: detail.model || null, modelStage: detail.modelStage || null,
              providerStatus: detail.providerStatus ?? null, quotaKind: detail.quotaKind || null,
              retryAfterMs: detail.retryAfterMs ?? null
            });
            // Finalize is idempotent: replaying it does not restart a failed
            // worker. Recover once through the explicit retry endpoint, using
            // the failure revision so a lost response cannot duplicate work.
            if (status.retryable && !recoveryRequested) {
              recoveryRequested = true;
              var revision = status.failure_id || (status.error && status.error.retryAt) || Math.floor(Date.now() / 60000);
              return request('/v1/recordings/' + encodeURIComponent(job.recordingId) + '/retry', {
                method: 'POST', signal: signal,
                headers: { 'Idempotency-Key': 'recover:' + job.recordingId + ':' + revision }
              }).then(function (reply) {
                if (reply.deferred && Number(reply.retry_at) > Date.now()) {
                  var waiting = new Error('Cloud processing is queued after the AI cooldown. Saved audio is retained.');
                  waiting.code = 'processing_deferred';
                  waiting.retryable = true;
                  waiting.retryAfterMs = Number(reply.retry_at) - Date.now();
                  throw waiting;
                }
                processor.onChange('Cloud processing retry queued');
                return abortableDelay(POLL_INTERVAL_MS, signal).then(poll);
              });
            }
            var failure = new Error(detail.message || status.error_code || 'Backend processing failed.');
            failure.retryable = typeof detail.retryable === 'boolean' ? detail.retryable : Boolean(status.retryable);
            for (var key of ['code', 'providerStatus', 'retryAfterMs', 'quotaKind', 'model', 'modelStage', 'source'])
              if (detail[key] !== undefined) failure[key] = detail[key];
            if (detail.code !== 'processing_deferred') failure.audioStage = 'processing saved audio';
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
      processingFailedStage: '', processingError: '', processingRetryable: false, processingRetryAt: 0,
      provider: 'synap', processedAt: new Date().toISOString()
    };
  }

  function consolidate(processor, job, signal) {
    return (job.cloudOnly ? Promise.resolve() : uploadHighlights(processor, job.recordingId, signal)
      .then(function () { return finalize(processor, job, signal); }))
      .then(function () {
        return waitForProcessing(processor, job, function (status) {
          var percent = Math.round((Number(status.progress) || 0) * 100);
          var label = { uploaded: 'Audio uploaded; waiting for processing', transcribing: 'Transcribing saved audio',
            understanding: 'Synap is understanding this conversation', indexing: 'Saving searchable memory', ready: 'Memory ready' }[status.state];
          if (label) processor.onChange(label + ' · ' + percent + '%');
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

  const recoveredProcessors = new WeakSet();
  const processingProvider = {
    // These jobs only store audio or complete a local placeholder. The worker
    // observes project-wide AI cooldowns independently after finalization.
    canRunDuringCooldown(job) { return job.kind === 'transcribe' || job.kind === 'summarize'; },
    async prepare(processor, config) {
      if (!root.SynapAuth || !root.SynapAuth.isSignedIn()) {
        processor.onChange('Sign in with Google to process pending memories.');
        return null;
      }
      const endpoint = managedEndpoint();
      if (!endpoint) {
        processor.onChange('Synap Cloud is not configured for this build.');
        return null;
      }
      if (!recoveredProcessors.has(processor) && !processor.recordingScope) {
        await recoverLegacyFinalizeFailures(processor);
        recoveredProcessors.add(processor);
      }
      return Object.assign({}, config, { endpoint: endpoint, llmEndpoint: endpoint, accountUid: accountUid() });
    },
    timeout(job) { return job.kind === 'consolidate' ? PROCESSING_TIMEOUT_MS : UPLOAD_TIMEOUT_MS; },
    async process(processor, job, config, signal) {
      if (!root.SynapAuth || !root.SynapAuth.isSignedIn()) {
        return Promise.reject(permanent('Sign in with Google in Settings to sync your memories.'));
      }
      const uid = config.accountUid || accountUid();
      if (!uid || uid !== accountUid()) throw permanent('Sign in with the recording owner to sync this recording.');
      const controller = new root.AbortController();
      const cancel = () => controller.abort();
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      const unsubscribe = root.SynapAuth.onChange?.(() => { if (uid !== accountUid()) cancel(); });
      accountScopes.set(controller.signal, uid);
      try {
        const check = record => {
          if (!record) throw permanent('Recording is no longer in local storage.');
          if (record.ownerUid && record.ownerUid !== uid) throw permanent('This recording belongs to another Google account. Sign in with that account to sync it.');
        };
        const record = await processor.store.get('recordings', job.recordingId);
        check(record);
        if (record.localOnly) return { localOnly: true, processingState: 'local', processingStage: 'local' };
        // Recordings made offline or before ownership metadata was introduced
        // are bound once, before their first managed request.
        if (!record.ownerUid && processor.store.atomic) await processor.store.atomic(['recordings'], stores => {
          const get = stores.recordings.get(job.recordingId);
          get.onsuccess = () => {
            // Throwing inside an IDB event does not reliably reject atomic().
            // A concurrent owner change is checked again after this transaction.
            if (get.result && !get.result.ownerUid) stores.recordings.put({ ...get.result, ownerUid: uid });
          };
        });
        check(await processor.store.get('recordings', job.recordingId));
        if (controller.signal.aborted || uid !== accountUid()) throw Object.assign(new Error('Google account changed during processing.'), { name: 'AbortError' });
        return await handle(processor, job, controller.signal);
      } finally {
        unsubscribe?.();
        signal?.removeEventListener('abort', cancel);
        accountScopes.delete(controller.signal);
      }
    }
  };
  root.DKFIFOProcessor?.registerProvider('synap', processingProvider);

  root.SynapBackend = {
    isManagedEndpoint:isManagedEndpoint,
    toRecordingFields:toRecordingFields,
    recordingMemory:function(id){return request('/v1/recordings/'+encodeURIComponent(id)+'/source');},
    segmentBounds:segmentBounds,
    transcriptionAudio:transcriptionAudio,
    requestBudget:requestBudget,
    ask:function(query,scope){return request('/v1/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:query,scope:scope||{}})});},
    dailyBrief:function(day){return request('/v1/days/'+encodeURIComponent(day)+'/brief');},
    people:function(){return request('/v1/people');},
    deletePerson:function(personId){var id=String(personId||'');if(!id)return Promise.reject(permanent('Person id is required.'));return request('/v1/people/'+encodeURIComponent(id),{method:'DELETE'});},
    retryRecording:function(recordingId){var id=String(recordingId||'');if(!id)return Promise.reject(permanent('Recording id is required.'));return request('/v1/recordings/'+encodeURIComponent(id)+'/retry',{method:'POST',headers:{'Idempotency-Key':userRetryKey(id)}});},
    deleteRecording:function(recordingId){var id=String(recordingId||'');if(!id)return Promise.reject(permanent('Recording id is required.'));return request('/v1/recordings/'+encodeURIComponent(id),{method:'DELETE'}).catch(function(error){if(error.status!==404)throw error;});},
    recordings:function(options){var opts=options||{},query=[];if(opts.day)query.push('day='+encodeURIComponent(opts.day));if(opts.limit)query.push('limit='+encodeURIComponent(opts.limit));if(opts.transcript)query.push('include_transcript=true');return request('/v1/recordings'+(query.length?'?'+query.join('&'):''));},
    followUps:function(state,owner){return request('/v1/follow-ups?state='+encodeURIComponent(state||'open')+'&owner='+encodeURIComponent(owner||'all'));},
    updateFollowUp:function(id,patch){return request('/v1/follow-ups/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});},
    resolveFollowUp:function(id,state){return request('/v1/follow-ups/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:state})});},
    confirmPerson:function(personId,confirmed){return request('/v1/people/'+encodeURIComponent(personId),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:confirmed!==false})});},
    renamePerson:function(personId,name){return request('/v1/people/'+encodeURIComponent(personId),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:String(name||'').trim()})});}
  };
})(globalThis);
