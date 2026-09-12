/* End-to-end source recovery for Library, transcript and memory surfaces.
 *
 * Local IndexedDB remains the fastest source for audio. Synap Cloud is the
 * authenticated fallback when the local PCM is absent (new browser, restored
 * history, browser eviction). Transcript/memory hydration always asks the
 * backend's authoritative source endpoint, which reconstructs text from sealed
 * 30-second windows instead of trusting a stale partial browser cache.
 */
(function (root) {
  'use strict';

  var hydrated = new Set();
  var sourcePending = Object.create(null);
  var transcriptNotices = new Map();
  var audioPending = new WeakMap();
  var objectUrls = new Set();

  function signedIn() {
    try { return Boolean(root.SynapAuth && root.SynapAuth.isSignedIn && root.SynapAuth.isSignedIn()); }
    catch (_) { return false; }
  }

  function recordingIdFromCard(card) {
    if (!card) return '';
    var id = String(card.id || '').replace(/^recording-/, '');
    if (id && id !== card.id) return id;
    return String(card.dataset && card.dataset.recordingId || '');
  }

  function request(path, options) {
    if (!root.SynapAuth || typeof root.SynapAuth.authedFetch !== 'function') {
      return Promise.reject(new Error('Synap account is unavailable.'));
    }
    return root.SynapAuth.authedFetch(path, options || {});
  }

  function json(path) {
    return request(path).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
        if (!response.ok) {
          var error = new Error(data && data.error && data.error.message || ('HTTP ' + response.status));
          error.status = response.status;
          throw error;
        }
        return data || {};
      });
    });
  }

  function openJournal() {
    if (!root.DKAudioStore) return Promise.reject(new Error('Recording journal is unavailable.'));
    var journal = new root.DKAudioStore({ onError: function () {} });
    return journal.open().then(function () { return journal; });
  }

  async function saveSource(id, source) {
    var journal = await openJournal();
    return journal.atomic(['recordings'], function (stores, result) {
      var get = stores.recordings.get(id);
      get.onsuccess = function () {
        var current = get.result;
        if (!current) { result(false); return; }
        var fields = {};
        if (source.state === 'ready' && (source.executive_summary || source.title || source.conversations) &&
            root.SynapBackend && typeof root.SynapBackend.toRecordingFields === 'function') {
          fields = root.SynapBackend.toRecordingFields(source) || {};
        }
        if (current.name || fields.name === undefined) delete fields.name;
        if (source.state) fields.processingState = source.state === 'ready' ? 'done' : 'pending';
        Object.assign(fields, {
          // An incomplete/empty source response cannot erase preserved words.
          transcript: typeof source.transcript === 'string' && (source.transcript.trim() || source.transcript_complete === true)
            ? source.transcript : String(current.transcript || ''),
          durationMs: Math.max(Number(current.durationMs) || 0, Number(source.duration_ms) || 0),
          processingStage: String(source.state || current.processingStage || ''),
          processingProgress: source.progress != null && Number.isFinite(Number(source.progress)) ? Number(source.progress) : current.processingProgress,
          processingError: source.error_code || '',
          processingRetryable: source.retryable !== false,
          sourceHydratedAt: new Date().toISOString(),
          transcriptComplete: source.transcript_complete === true,
          transcriptSegments: Number(source.transcript_segments || 0),
          sourceSegmentCount: Number(source.segment_count || 0)
        });
        // Merge in the transaction so notes/audio edits and deletions which
        // finished during the request cannot be undone by a stale snapshot.
        var saved = Object.assign({}, current, fields);
        stores.recordings.put(saved);
        result(saved);
      };
    });
  }

  function paintTranscriptNotice(node, latest) {
    if (latest) node.synapRecording = latest;
    var recording = node.synapRecording || {};
    var state = transcriptNotices.get(String(recording.id)) || {};
    var hasText = Boolean(String(recording.transcript || '').trim());
    var message = state.message || '';
    if (!message && !hasText) {
      message = recording.transcriptComplete ? 'No speech was found in this recording.'
        : recording.sourceHydratedAt ? 'The transcript is not ready yet. Check memory processing in Library.'
        : signedIn() ? 'Load this recording’s transcript.' : 'No transcript saved yet. Process this recording to create one.';
    } else if (!message && recording.sourceHydratedAt && !recording.transcriptComplete) {
      message = 'Transcript available so far. Some audio still needs transcription.';
    }
    var text = node.querySelector('p');
    text.textContent = message;
    text.hidden = !message;
    var button = node.querySelector('button');
    button.textContent = state.error ? 'Retry transcript' : hasText ? 'Refresh transcript' : 'Load transcript';
    button.disabled = state.loading === true;
    button.hidden = !recording.id || !signedIn();
    node.setAttribute('aria-busy', String(state.loading === true));
  }

  function createTranscriptNotice(recording) {
    var node = root.document.createElement('div');
    node.className = 'synap-transcript-notice';
    node.dataset.recordingId = String(recording.id);
    node.synapRecording = recording;
    var text = root.document.createElement('p');
    text.setAttribute('role', 'status');
    var button = root.document.createElement('button');
    button.type = 'button';
    button.className = 'button button-secondary button-small synap-transcript-retry';
    button.addEventListener('click', function () { hydrateSource(recording.id, true); });
    node.append(text, button);
    paintTranscriptNotice(node);
    return node;
  }

  function updateTranscriptNotices(id, state, recording) {
    if (state) transcriptNotices.set(id, state); else transcriptNotices.delete(id);
    var nodes = root.document && root.document.querySelectorAll('.synap-transcript-notice');
    Array.from(nodes || []).forEach(function (node) {
      if (node.dataset.recordingId !== id) return;
      if (recording) node.synapRecording = recording;
      paintTranscriptNotice(node);
    });
  }

  function refreshUi(id) {
    try {
      if (root.SynapCloudHistory && typeof root.SynapCloudHistory.refreshUiInPlace === 'function') {
        root.SynapCloudHistory.refreshUiInPlace({ updated: 1, recordingId: id, source: 'authoritative-source' });
        return;
      }
    } catch (_) {}
    try {
      var picker = root.document && root.document.getElementById('datePicker');
      if (picker && typeof picker.dispatchEvent === 'function' && typeof root.Event === 'function') {
        picker.dispatchEvent(new root.Event('change', { bubbles: true }));
      }
    } catch (_) {}
  }

  function hydrateSource(recordingId, force) {
    var id = String(recordingId || '');
    if (!id || !signedIn()) return Promise.resolve(false);
    if (!force && hydrated.has(id)) return Promise.resolve(true);
    if (sourcePending[id]) return sourcePending[id];
    if (force) hydrated.delete(id);

    updateTranscriptNotices(id, { loading: true, message: 'Loading transcript…' });

    var task = json('/v1/recordings/' + encodeURIComponent(id) + '/source')
      .then(function (source) { return saveSource(id, source).then(function (saved) { return [source, saved]; }); })
      .then(function (values) {
        var source = values[0], saved = values[1];
        if (saved && source.transcript_complete === true && source.state === 'ready') hydrated.add(id);
        updateTranscriptNotices(id, null, saved || null);
        if (saved) refreshUi(id);
        return Boolean(saved);
      })
      .catch(function (error) {
        if (root.console && root.console.warn) root.console.warn('[synap source] hydration failed', error);
        updateTranscriptNotices(id, { error: true, message: 'Could not load the transcript. Check your connection and try again.' });
        return false;
      })
      .finally(function () { delete sourcePending[id]; });

    sourcePending[id] = task;
    return task;
  }

  function playbackStatus(audio, text, error) {
    var content = audio && audio.closest ? audio.closest('.recording-content') : null;
    if (!content) return;
    var node = content.querySelector('.recording-playback-status');
    if (!node) {
      node = root.document.createElement('p');
      node.className = 'recording-playback-status';
      node.setAttribute('role', 'status');
      node.style.margin = '6px 0 0';
      node.style.fontSize = '0.72rem';
      audio.insertAdjacentElement('afterend', node);
    }
    node.textContent = text || '';
    node.hidden = !text;
    node.style.color = error ? 'var(--rose)' : 'var(--muted)';
  }

  function releaseOwnedUrl(audio) {
    var old = audio && audio.dataset && audio.dataset.synapExperienceUrl;
    if (!old || !objectUrls.has(old)) return;
    try { root.URL.revokeObjectURL(old); } catch (_) {}
    objectUrls.delete(old);
    delete audio.dataset.synapExperienceUrl;
  }

  function attachBlob(audio, blob, source) {
    if (!blob || !blob.size) throw new Error('No playable audio bytes are available.');
    releaseOwnedUrl(audio);
    var url = root.URL.createObjectURL(blob);
    objectUrls.add(url);
    audio.dataset.synapExperienceUrl = url;
    audio.dataset.synapAudioSource = source;
    audio.src = url;
    audio.preload = 'metadata';
    audio.load();
    playbackStatus(audio, '', false);
    return true;
  }

  async function localAudio(recordingId) {
    var journal = await openJournal();
    var recording = await journal.get('recordings', recordingId);
    if (!recording) throw new Error('Recording is not in this browser journal.');
    if (recording.blob && recording.blob.size) return recording.blob;
    return journal.blob(recording);
  }

  async function cloudAudio(recordingId) {
    if (!signedIn()) throw new Error('Sign in to recover source audio from Synap Cloud.');
    var response = await request('/v1/recordings/' + encodeURIComponent(recordingId) + '/audio');
    if (!response.ok) {
      var text = await response.text().catch(function () { return ''; });
      var message = text;
      try { message = JSON.parse(text).error.message; } catch (_) {}
      var error = new Error(message || ('HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return response.blob();
  }

  function cloudFallback(audio, id) {
    if (!audio || !id || audioPending.has(audio)) return audioPending.get(audio) || Promise.resolve(false);
    audio.setAttribute('aria-busy', 'true');
    audio.dataset.synapCloudRecovery = '1';
    playbackStatus(audio, 'Recovering audio from Synap Cloud…', false);
    var task = cloudAudio(id)
      .then(function (blob) { return attachBlob(audio, blob, 'cloud'); })
      .catch(function (error) {
        playbackStatus(audio, error && error.status === 410
          ? 'Source audio is no longer retained in Synap Cloud.'
          : 'Audio could not be loaded. The recording itself is still preserved.', true);
        return false;
      })
      .finally(function () {
        audio.removeAttribute('aria-busy');
        audioPending.delete(audio);
      });
    audioPending.set(audio, task);
    return task;
  }

  function ensureAudio(audio) {
    if (!audio) return Promise.resolve(false);
    if (audio.src || audio.currentSrc) return Promise.resolve(true);
    if (audioPending.has(audio)) return audioPending.get(audio);
    var card = audio.closest && audio.closest('.recording-card');
    var id = recordingIdFromCard(card);
    if (!id) return Promise.resolve(false);

    audio.setAttribute('aria-busy', 'true');
    playbackStatus(audio, 'Loading source audio…', false);
    var task = localAudio(id)
      .then(function (blob) { return attachBlob(audio, blob, 'local'); })
      .catch(function () {
        return cloudAudio(id).then(function (blob) { return attachBlob(audio, blob, 'cloud'); });
      })
      .catch(function (error) {
        playbackStatus(audio, error && error.status === 410
          ? 'Source audio is no longer retained in Synap Cloud.'
          : 'Audio could not be loaded. The recording itself is still preserved.', true);
        return false;
      })
      .finally(function () {
        audio.removeAttribute('aria-busy');
        audioPending.delete(audio);
      });
    audioPending.set(audio, task);
    return task;
  }

  function recoverMediaError(audio) {
    if (!audio || !audio.closest || !audio.closest('.recording-card')) return;
    // If the authenticated cloud copy itself cannot be decoded, do not loop.
    if (audio.dataset.synapAudioSource === 'cloud' || audio.dataset.synapCloudRecovery === '1') {
      playbackStatus(audio, 'Audio could not be decoded by this browser.', true);
      return;
    }
    var id = recordingIdFromCard(audio.closest('.recording-card'));
    if (!id) return;
    releaseOwnedUrl(audio);
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (_) {}
    cloudFallback(audio, id);
  }

  function bind() {
    if (!root.document || root.document.__synapExperienceRecoveryInstalled) return;
    root.document.__synapExperienceRecoveryInstalled = true;

    if (root.SynapBackend) {
      root.SynapBackend.recordingMemory = function (id) {
        return json('/v1/recordings/' + encodeURIComponent(String(id || '')) + '/source');
      };
      root.SynapBackend.recordingAudio = cloudAudio;
    }

    root.document.addEventListener('toggle', function (event) {
      var card = event && event.target;
      if (!card || !card.classList || !card.classList.contains('recording-card') || !card.open) return;
      var id = recordingIdFromCard(card);
      if (id && !root.SynapCloudHistory) hydrateSource(id, false);
      root.setTimeout(function () {
        var audio = card.querySelector && card.querySelector('audio');
        if (audio && !audio.src && !audio.currentSrc) ensureAudio(audio);
      }, 20);
    }, true);

    root.document.addEventListener('toggle', function (event) {
      var target = event && event.target;
      if (!target || !target.open || !target.classList.contains('recording-disclosure') || !target.querySelector('.recording-transcript')) return;
      var card = target.closest('.recording-card');
      if (card) hydrateSource(recordingIdFromCard(card), false);
    }, true);

    root.document.addEventListener('pointerdown', function (event) {
      var audio = event && event.target && event.target.closest ? event.target.closest('audio') : null;
      if (audio && audio.closest('.recording-card') && !audio.src && !audio.currentSrc) ensureAudio(audio);
    }, true);

    // Media error does not bubble, therefore capture phase is intentional. It
    // catches stale/revoked object URLs created by the older Library player too.
    root.document.addEventListener('error', function (event) {
      var audio = event && event.target;
      if (!audio || String(audio.tagName || '').toUpperCase() !== 'AUDIO') return;
      recoverMediaError(audio);
    }, true);

    root.document.addEventListener('click', function (event) {
      var tab = event && event.target && event.target.closest ? event.target.closest('.synap-memory-tabs button') : null;
      if (!tab || String(tab.textContent || '').trim() !== 'Transcript') return;
      var card = tab.closest('.insight-card[data-recording-id]');
      if (card && card.dataset.recordingId && !root.SynapCloudHistory) hydrateSource(card.dataset.recordingId, false);
    }, true);

    if (typeof root.addEventListener === 'function') {
      root.addEventListener('synap-memory-ready', function (event) {
        var id = event && event.detail && event.detail.recordingId;
        if (!id) return;
        hydrated.delete(String(id));
        if (!root.SynapCloudHistory) hydrateSource(id, true);
      });
      root.addEventListener('pagehide', function () {
        objectUrls.forEach(function (url) { try { root.URL.revokeObjectURL(url); } catch (_) {} });
        objectUrls.clear();
      }, { once: true });
    }
  }

  function installWhenReady(attempt) {
    if (root.SynapBackend && root.DKAudioStore && root.SynapAuth) { bind(); return; }
    if (attempt >= 100) { bind(); return; }
    root.setTimeout(function () { installWhenReady(attempt + 1); }, 50);
  }

  installWhenReady(0);
  root.SynapExperienceRecovery = {
    hydrateSource: hydrateSource,
    createTranscriptNotice: createTranscriptNotice,
    updateTranscriptNotice: paintTranscriptNotice,
    ensureAudio: ensureAudio,
    cloudAudio: cloudAudio,
    recoverMediaError: recoverMediaError,
    recordingIdFromCard: recordingIdFromCard,
    bind: bind
  };
})(globalThis);
