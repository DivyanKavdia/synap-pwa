/* Synap Cloud processing recovery.
 *
 * Cloud Tasks is the preferred background worker. The PWA only provides a
 * bounded safety net: if one backend processing state AND its progress stop
 * advancing, ask the authenticated recovery endpoint to inspect it. The
 * backend remains the authority on whether a worker is genuinely stale and
 * safe to restart.
 *
 * This module observes processing-status responses only. It never touches BLE,
 * capture, audio bytes, IndexedDB or custom providers.
 */
(function (root) {
  'use strict';

  var STALL_MS = 30000;
  var RETRY_MS = 60000;
  var RECOVERY_REQUEST_TIMEOUT_MS = 30000;
  var RECOVERABLE_STATES = new Set(['uploaded', 'transcribing', 'understanding', 'indexing']);
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

  function normalizedProgress(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(Math.max(0, Math.min(1, number)) * 10000) / 10000;
  }

  function responseError(response) {
    if (response && (response.ok || response.status === 202)) return Promise.resolve(null);
    if (!response || typeof response.text !== 'function') {
      return Promise.reject(new Error('Processing recovery request failed.'));
    }
    return response.text().then(function (text) {
      throw new Error(text || ('HTTP ' + response.status));
    });
  }

  function recoveryRequest(recordingId, originalFetch) {
    var Controller = root.AbortController;
    var controller = typeof Controller === 'function' ? new Controller() : null;
    var timer = null;
    var timeoutPromise = null;

    if (typeof root.setTimeout === 'function') {
      timeoutPromise = new Promise(function (_, reject) {
        timer = root.setTimeout(function () {
          if (controller) controller.abort();
          var error = new Error('Processing recovery request timed out.');
          error.name = 'TimeoutError';
          reject(error);
        }, RECOVERY_REQUEST_TIMEOUT_MS);
      });
    }

    var init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    };
    if (controller) init.signal = controller.signal;

    var network = Promise.resolve().then(function () {
      return originalFetch('/v1/recordings/' + encodeURIComponent(recordingId) + '/process-now', init);
    }).then(responseError);

    var request = timeoutPromise ? Promise.race([network, timeoutPromise]) : network;
    return request.then(function (value) {
      if (timer !== null && typeof root.clearTimeout === 'function') root.clearTimeout(timer);
      return value;
    }, function (error) {
      if (timer !== null && typeof root.clearTimeout === 'function') root.clearTimeout(timer);
      throw error;
    });
  }

  function observeStatus(recordingId, status, originalFetch, at) {
    recordingId = String(recordingId || '');
    status = status || {};
    var state = String(status.state || '').toLowerCase();
    var progress = normalizedProgress(status.progress);
    at = Number.isFinite(at) ? at : now();
    if (!recordingId) return;

    if (!RECOVERABLE_STATES.has(state)) {
      clear(recordingId);
      return;
    }

    var entry = entries.get(recordingId);
    if (!entry) {
      entry = {
        state: state,
        progress: progress,
        since: at,
        lastAttempt: 0,
        inFlight: false
      };
      entries.set(recordingId, entry);
      return;
    }

    // Progress is a heartbeat. Transcription can remain in one stage for a long
    // recording while individual 30-second windows complete. Never call the
    // recovery endpoint while that percentage is still moving.
    if (entry.state !== state || entry.progress !== progress) {
      entry.state = state;
      entry.progress = progress;
      entry.since = at;
      entry.lastAttempt = 0;
      return;
    }

    if (at - entry.since < STALL_MS || entry.inFlight ||
        (entry.lastAttempt > 0 && at - entry.lastAttempt < RETRY_MS)) return;
    if (typeof originalFetch !== 'function') return;

    entry.inFlight = true;
    entry.lastAttempt = at;

    recoveryRequest(recordingId, originalFetch)
      .catch(function () {
        // Normal polling remains authoritative. A failed/timed-out recovery may
        // try again after RETRY_MS, while Cloud Tasks may recover independently.
      })
      .then(function () {
        // Always release the gate, including network hangs that hit our timeout.
        // Keep the entry only if this recording is still being watched.
        if (entries.get(recordingId) === entry) entry.inFlight = false;
      });
  }

  // Backward-compatible test/support surface for callers that only know state.
  function observeState(recordingId, state, originalFetch, at) {
    observeStatus(recordingId, { state: state, progress: null }, originalFetch, at);
  }

  function observeResponse(path, response, originalFetch) {
    var recordingId = recordingIdFromPath(path);
    if (!recordingId || !response || typeof response.clone !== 'function') return;
    try {
      response.clone().json().then(function (status) {
        observeStatus(recordingId, status || {}, originalFetch, now());
      }).catch(function () { /* Malformed status must not break normal polling. */ });
    } catch (_) {
      // Response cloning is best effort only.
    }
  }

  root.SynapProcessingRecovery = {
    observeResponse: observeResponse,
    observeStatus: observeStatus,
    observeState: observeState,
    clear: clear,
    STALL_MS: STALL_MS,
    RETRY_MS: RETRY_MS,
    RECOVERY_REQUEST_TIMEOUT_MS: RECOVERY_REQUEST_TIMEOUT_MS,
    RECOVERABLE_STATES: RECOVERABLE_STATES,
    _entries: entries
  };
})(globalThis);