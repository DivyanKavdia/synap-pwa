/* Restore account memory into the local recording journal without reloading the page. */
(function (root) {
  'use strict';

  var STORE = 'recordings';
  var LIMIT = 100;
  var SYNCED_KEY = 'synap-cloud-history-synced';
  var running = false;
  var lastRefreshAt = 0;
  /* Processing itself writes the finished memory locally, so background account
     reconciliation does not need to redownload up to 100 transcripts every minute. */
  var REFRESH_MS = 5 * 60 * 1000;

  var CLOUD_DERIVED_FIELDS = [
    'transcript', 'summary', 'meeting', 'people', 'conversations',
    'processingState', 'processingStage', 'processingProgress',
    'processingFailedStage', 'processingError', 'processingRetryable',
    'provider', 'durationMs'
  ];

  /* These are browser bookkeeping timestamps, not memory content. Generating a
     fresh value on every sync used to make an unchanged recording look changed,
     which in turn caused repeated location.reload() calls. A reload destroys the
     Web Bluetooth GATT connection even though the pendant itself is healthy. */
  var VOLATILE_FIELDS = ['restoredAt', 'processedAt', 'processingUpdatedAt'];

  function backend() {
    return root.SynapBackend || null;
  }

  function signedIn() {
    return Boolean(root.SynapAuth && root.SynapAuth.isSignedIn && root.SynapAuth.isSignedIn());
  }

  function store() {
    if (!root.DKAudioStore) return Promise.reject(new Error('journal unavailable'));
    var journal = new root.DKAudioStore({ onError: function () {} });
    return journal.open().then(function () { return journal; });
  }

  function cloudReady(restored) {
    return Boolean(restored && restored.restoredFromCloud === true &&
      (restored.processingStage === 'ready' || restored.processingState === 'done'));
  }

  function empty(value) {
    return value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0);
  }

  // Preserve local source/user fields; completed cloud-derived fields win.
  function merge(local, restored) {
    var merged = Object.assign({}, restored, local);
    if (!local) return merged;

    Object.keys(restored).forEach(function (key) {
      if (empty(local[key]) && restored[key] !== undefined) merged[key] = restored[key];
    });

    if (cloudReady(restored)) {
      CLOUD_DERIVED_FIELDS.forEach(function (key) {
        if (restored[key] !== undefined) merged[key] = restored[key];
      });
    }

    /* Keep established bookkeeping timestamps stable. They are not evidence that
       a cloud memory changed. */
    VOLATILE_FIELDS.forEach(function (key) {
      if (local[key] !== undefined) merged[key] = local[key];
    });
    return merged;
  }

  function comparable(record) {
    var copy = Object.assign({}, record || {});
    VOLATILE_FIELDS.forEach(function (key) { delete copy[key]; });
    return JSON.stringify(copy);
  }

  function meaningfullyChanged(local, merged) {
    return comparable(local) !== comparable(merged);
  }

  function toLocal(item) {
    item = item || {};
    var api = backend();
    var startedAt = item.started_at || new Date().toISOString();
    var record = {
      id: item.recording_id,
      createdAt: startedAt,
      durationMs: Math.max(0, Math.round(Number(item.duration_ms) || 0)),
      notes: '',
      transcript: '',
      summary: '',
      sizeBytes: 0,
      restoredFromCloud: true,
      restoredAt: new Date().toISOString()
    };

    var ready = item.state === 'ready' || item.title !== undefined || item.conversations !== undefined;
    if (ready && api && typeof api.toRecordingFields === 'function') {
      var fields = api.toRecordingFields(item) || {};
      Object.keys(fields).forEach(function (key) {
        if (fields[key] !== undefined) record[key] = fields[key];
      });
    }
    if (typeof item.transcript === 'string') record.transcript = item.transcript;
    if (!record.name) {
      record.name = new Date(startedAt).toLocaleString([], {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      });
    }
    if (!ready) {
      record.processingState = 'pending';
      record.processingStage = String(item.state || 'uploaded');
    }
    return record;
  }

  function write(journal, records) {
    return journal.atomic([STORE], function (stores) {
      records.forEach(function (record) { stores[STORE].put(record); });
    }).then(function () { return records.length; });
  }

  function plan(locals, force) {
    if (!locals.length) return { fetch: true, transcript: true };
    var synced = false;
    try { synced = root.sessionStorage.getItem(SYNCED_KEY) === '1'; } catch (error) {}
    if (synced && !force) return { fetch: false, transcript: false };
    return { fetch: true, transcript: false };
  }

  function restore(force) {
    if (running || !signedIn()) return Promise.resolve({ restored: 0, updated: 0 });
    var api = backend();
    if (!api || typeof api.recordings !== 'function') return Promise.resolve({ restored: 0, updated: 0 });

    running = true;
    var db = null;

    return store().then(function (opened) {
      db = opened;
      return db.all(STORE);
    }).then(function (locals) {
      var choice = plan(locals, force);
      if (!choice.fetch) return [locals, null];
      try { root.sessionStorage.setItem(SYNCED_KEY, '1'); } catch (error) {}

      /* Correctness still wins for the bounded account-history window: a local
         transcript can be an old partial result, so reconcile with cloud text. */
      return api.recordings({ limit: LIMIT, transcript: true })
        .then(function (result) { return [locals, result]; });
    }).then(function (results) {
      var locals = results[0];
      var remote = (results[1] && results[1].recordings) || [];
      var byId = new Map();
      locals.forEach(function (record) {
        if (record && record.id) byId.set(String(record.id), record);
      });

      var writes = [];
      var restored = 0;
      var updated = 0;

      remote.forEach(function (item) {
        if (!item || !item.recording_id) return;
        var local = byId.get(String(item.recording_id));
        var mapped = toLocal(item);

        if (!local) {
          writes.push(mapped);
          restored += 1;
          return;
        }

        var merged = merge(local, mapped);
        if (meaningfullyChanged(local, merged)) {
          writes.push(merged);
          updated += 1;
        }
      });

      lastRefreshAt = Date.now();
      if (!writes.length) return { restored: 0, updated: 0 };
      return write(db, writes).then(function () {
        return { restored: restored, updated: updated };
      });
    }).then(function (result) {
      running = false;
      return result;
    }).catch(function (error) {
      running = false;
      console.warn('[synap history] could not restore from cloud', error);
      return { restored: 0, updated: 0, error: error };
    });
  }

  var BUSY = ['recording', 'starting', 'stopping', 'saving', 'updating'];

  function busy() {
    var state = root.document && root.document.body && root.document.body.dataset
      ? root.document.body.dataset.state
      : '';
    return BUSY.indexOf(String(state || '')) !== -1;
  }

  /* Refresh rendered memory in place. Never reload the document: a document
     reload is also a Bluetooth disconnect on Web Bluetooth clients. */
  function refreshUiInPlace(result) {
    try {
      if (root.SynapMemoryTools && typeof root.SynapMemoryTools.refresh === 'function') {
        Promise.resolve(root.SynapMemoryTools.refresh()).catch(function () {});
      }
    } catch (error) {}

    try {
      var picker = root.document && root.document.getElementById
        ? root.document.getElementById('datePicker')
        : null;
      if (picker && !busy() && typeof picker.dispatchEvent === 'function') {
        var EventCtor = root.Event;
        if (typeof EventCtor === 'function') picker.dispatchEvent(new EventCtor('change', { bubbles: true }));
      }
    } catch (error) {}

    try {
      if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent('synap-cloud-history-updated', { detail: result || {} }));
      }
    } catch (error) {}
  }

  function restoreAndShow(force) {
    return restore(force).then(function (result) {
      var changed = (result.restored || 0) + (result.updated || 0);
      if (changed) refreshUiInPlace(result);
      return result;
    });
  }

  function onAuthChange(session) {
    if (!session || !session.refreshToken) {
      try { root.sessionStorage.removeItem(SYNCED_KEY); } catch (error) {}
      return;
    }
    restoreAndShow(true);
  }

  function loadTranscriptRepair() {
    if (!root.document || root.SynapTranscriptRepair ||
        root.document.querySelector('script[data-synap-transcript-repair]')) return;
    var script = root.document.createElement('script');
    script.src = 'transcript-repair.js?v=1.0.0-transcript1';
    script.async = false;
    script.setAttribute('data-synap-transcript-repair', '1');
    (root.document.body || root.document.head).appendChild(script);
  }

  function loadRuntimeModule(source, marker, ready) {
    if (!root.document || (ready && ready())) return;
    if (root.document.querySelector('script[' + marker + ']')) return;
    var script = root.document.createElement('script');
    script.src = source;
    script.async = false;
    script.setAttribute(marker, '1');
    (root.document.body || root.document.head).appendChild(script);
  }

  function loadProductRuntime() {
    loadRuntimeModule('capture-stability.js?v=1.0.0-stability2', 'data-synap-capture-stability', function () {
      return Boolean(root.SynapCaptureStability);
    });
    loadRuntimeModule('recording-bridge.js?v=1.0.0-continuity1', 'data-synap-recording-bridge', function () {
      return Boolean(root.SynapRecordingBridge);
    });
    loadRuntimeModule('memory-tools.js?v=1.0.0-transcript2', 'data-synap-memory-tools', function () {
      return Boolean(root.SynapMemoryTools);
    });
    loadRuntimeModule('cost-ui.js?v=1.0.0-cost1', 'data-synap-cost-ui', function () {
      return Boolean(root.SynapCostUI);
    });
  }

  function refreshVisible() {
    if (!signedIn() || busy()) return;
    if (Date.now() - lastRefreshAt < REFRESH_MS) return;
    restoreAndShow(true);
  }

  function init() {
    loadProductRuntime();
    if (root.SynapAuth && typeof root.SynapAuth.onChange === 'function') {
      root.SynapAuth.onChange(onAuthChange);
    }
    if (signedIn()) restoreAndShow();
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.visibilityState === 'visible') refreshVisible();
      });
    }
    loadTranscriptRepair();
  }

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  root.SynapCloudHistory = {
    restore: restore,
    restoreAndShow: restoreAndShow,
    toLocal: toLocal,
    merge: merge,
    plan: plan,
    busy: busy,
    meaningfullyChanged: meaningfullyChanged,
    refreshUiInPlace: refreshUiInPlace,
    loadTranscriptRepair: loadTranscriptRepair,
    loadProductRuntime: loadProductRuntime,
    refreshVisible: refreshVisible
  };
})(globalThis);
