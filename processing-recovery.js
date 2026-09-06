/* Synap Cloud processing recovery.
 *
 * Cloud Tasks is the preferred background worker. If the backend remains in
 * `uploaded` for 30 seconds, the task has not started. While the user is still
 * signed in and the PWA is open, make one authenticated recovery request to the
 * same Cloud Run service. The backend owns the safety checks and only processes
 * this user's uploaded/retryable recording.
 *
 * This module observes the existing processing-status polls. It never touches
 * BLE, capture, audio bytes, IndexedDB or custom providers.
 */
(function (root) {
  'use strict';

  var STALL_MS = 30000;
  var RETRY_MS = 60000;
  var entries = new Map();

  function now() {
    return Date.now();
  }

  function recordingIdFromPath(path) {
    var match = String(path || '').match(/\/v1\/recordings\/([^/?#]+)\/processing(?:[?#]|$)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function clear(recordingId) {
    entries.delete(String(recordingId));
  }

  function observeState(recordingId, state, originalFetch, at) {
    recordingId = String(recordingId || '');
    state = String(state || '').toLowerCase();
    at = Number.isFinite(at) ? at : now();
    if (!recordingId) return;

    if (state !== 'uploaded') {
      if (state === 'transcribing' || state === 'understanding' || state === 'indexing' ||
          state === 'ready' || state === 'failed') clear(recordingId);
      return;
    }

    var entry = entries.get(recordingId);
    if (!entry) {
      entry = { since: at, lastAttempt: 0, inFlight: false };
      entries.set(recordingId, entry);
      return;
    }
    if (at - entry.since < STALL_MS || entry.inFlight ||
        (entry.lastAttempt > 0 && at - entry.lastAttempt < RETRY_MS)) return;
    if (typeof originalFetch !== 'function') return;

    entry.inFlight = true;
    entry.lastAttempt = at;

    originalFetch('/v1/recordings/' + encodeURIComponent(recordingId) + '/process-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function (response) {
      if (response && response.ok) return null;
      if (!response || typeof response.text !== 'function') throw new Error('Processing recovery request failed.');
      return response.text().then(function (text) {
        throw new Error(text || ('HTTP ' + response.status));
      });
    }).catch(function () {
      // Normal polling remains authoritative. A failed recovery may try once
      // more after RETRY_MS, and the backend/Cloud Tasks can still recover too.
    }).then(function () {
      entry.inFlight = false;
    });
  }

  function observeResponse(path, response, originalFetch) {
    var recordingId = recordingIdFromPath(path);
    if (!recordingId || !response || typeof response.clone !== 'function') return;
    try {
      response.clone().json().then(function (status) {
        observeState(recordingId, status && status.state, originalFetch, now());
      }).catch(function () { /* A malformed status response must not break polling. */ });
    } catch (error) {
      // Response cloning is best effort only.
    }
  }

  function install() {
    var auth = root.SynapAuth;
    if (!auth || typeof auth.authedFetch !== 'function') return false;
    if (auth.__synapProcessingRecoveryInstalled) return true;

    var originalFetch = auth.authedFetch;
    auth.authedFetch = function (path, options) {
      return originalFetch(path, options).then(function (response) {
        observeResponse(path, response, originalFetch);
        return response;
      });
    };
    auth.__synapProcessingRecoveryInstalled = true;
    return true;
  }

  install();
  root.SynapProcessingRecovery = {
    install: install,
    observeState: observeState,
    clear: clear,
    STALL_MS: STALL_MS,
    RETRY_MS: RETRY_MS,
    _entries: entries
  };
})(globalThis);
