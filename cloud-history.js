/* Restore account memory into the local recording journal without reloading the page. */
(function (root) {
  'use strict';

  var STORE = 'recordings';
  var LIMIT = 100;
  var SYNCED_KEY = 'synap-cloud-history-synced';
  var running = false;
  var targetedRunning = Object.create(null);

  var CLOUD_DERIVED_FIELDS = [
    'transcript', 'summary', 'meeting', 'people', 'conversations',
    'processingState', 'processingStage', 'processingProgress',
    'processingFailedStage', 'processingError', 'processingRetryable',
    'provider', 'durationMs'
  ];

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

  function currentDay() {
    try {
      var picker = root.document && root.document.getElementById
        ? root.document.getElementById('datePicker')
        : null;
      if (picker && picker.value) return String(picker.value);
    } catch (error) {}
    var now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  }

  function cloudReady(restored) {
    return Boolean(restored && restored.restoredFromCloud === true &&
      (restored.processingStage === 'ready' || restored.processingState === 'done'));
  }

  function empty(value) {
    return value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0);
  }

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

  function mergeRemote(journal, locals, remote) {
    var byId = new Map();
    locals.forEach(function (record) {
      if (record && record.id) byId.set(String(record.id), record);
    });

    var writes = [];
    var restored = 0;
    var updated = 0;

    (remote || []).forEach(function (item) {
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

    if (!writes.length) return Promise.resolve({ restored: 0, updated: 0 });
    return write(journal, writes).then(function () {
      return { restored: restored, updated: updated };
    });
  }

  /* Account/day reconciliation. This is no longer called on a timer or every
     visibility change. The caller decides when fresh data is useful. */
  function restore(force, options) {
    options = options || {};
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
      if (!choice.fetch && !options.day) return [locals, null];
      try { root.sessionStorage.setItem(SYNCED_KEY, '1'); } catch (error) {}

      var requestOptions = { limit: options.limit || LIMIT };
      if (options.day) requestOptions.day = options.day;
      /* A brand-new device may hydrate its bounded history once. Existing
         devices fetch transcript text lazily when a recording is opened. */
      requestOptions.transcript = options.transcript === true ||
        (!locals.length && options.transcript !== false && !options.day);
      return api.recordings(requestOptions).then(function (result) {
        return [locals, result];
      });
    }).then(function (results) {
      var locals = results[0];
      var remote = (results[1] && results[1].recordings) || [];
      if (!results[1]) return { restored: 0, updated: 0 };
      return mergeRemote(db, locals, remote);
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

  function refreshUiInPlace(result) {
    try {
      if (root.SynapMemoryTools && typeof root.SynapMemoryTools.refresh === 'function') {
        Promise.resolve(root.SynapMemoryTools.refresh()).catch(function () {});
      }
    } catch (error) {}

    try {
      if (root.SynapProcessingPipeline && typeof root.SynapProcessingPipeline.refresh === 'function') {
        Promise.resolve(root.SynapProcessingPipeline.refresh()).catch(function () {});
      }
    } catch (error) {}

    try {
      var picker = root.document && root.document.getElementById
        ? root.document.getElementById('datePicker')
        : null;
      if (picker && !busy() && typeof picker.dispatchEvent === 'function') {
        var EventCtor = root.Event;
        if (typeof EventCtor === 'function') {
          var event = new EventCtor('change', { bubbles: true });
          try { event.__synapCloudInternal = true; } catch (error) {}
          picker.dispatchEvent(event);
        }
      }
    } catch (error) {}

    try {
      if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent('synap-cloud-history-updated', { detail: result || {} }));
      }
    } catch (error) {}
  }

  function restoreAndShow(force, options) {
    return restore(force, options).then(function (result) {
      var changed = (result.restored || 0) + (result.updated || 0);
      if (changed) refreshUiInPlace(result);
      return result;
    });
  }

  function restoreDay(day) {
    if (!day || busy()) return Promise.resolve({ restored: 0, updated: 0 });
    return restoreAndShow(true, { day: String(day), transcript: false });
  }

  /* Fetch one completed memory/transcript only when it becomes relevant to the
     user (open card / transcript view / newly-created summary). */
  function restoreRecording(recordingId, force) {
    var id = String(recordingId || '');
    if (!id || !signedIn()) return Promise.resolve({ restored: 0, updated: 0 });
    var api = backend();
    if (!api || typeof api.recordingMemory !== 'function') return Promise.resolve({ restored: 0, updated: 0 });
    if (targetedRunning[id]) return targetedRunning[id];

    var task = store().then(function (journal) {
      return journal.all(STORE).then(function (locals) {
        var local = (locals || []).find(function (item) { return item && String(item.id) === id; });
        var alreadyComplete = local && String(local.transcript || '').trim() && String(local.summary || '').trim() &&
          (local.processingStage === 'ready' || local.processingState === 'done');
        if (alreadyComplete && !force) return { restored: 0, updated: 0 };

        return api.recordingMemory(id).then(function (memory) {
          memory = Object.assign({}, memory || {}, {
            recording_id: id,
            state: 'ready',
            started_at: (memory && memory.started_at) || (local && local.createdAt) || new Date().toISOString(),
            duration_ms: Number((memory && memory.duration_ms) || (local && local.durationMs) || 0)
          });
          var mapped = toLocal(memory);
          if (!local) {
            return write(journal, [mapped]).then(function () { return { restored: 1, updated: 0 }; });
          }
          var merged = merge(local, mapped);
          if (!meaningfullyChanged(local, merged)) return { restored: 0, updated: 0 };
          return write(journal, [merged]).then(function () { return { restored: 0, updated: 1 }; });
        });
      });
    }).then(function (result) {
      delete targetedRunning[id];
      if ((result.restored || 0) + (result.updated || 0)) refreshUiInPlace(result);
      return result;
    }).catch(function (error) {
      delete targetedRunning[id];
      return { restored: 0, updated: 0, error: error };
    });

    targetedRunning[id] = task;
    return task;
  }

  function onAuthChange(session) {
    if (!session || !session.refreshToken) {
      try { root.sessionStorage.removeItem(SYNCED_KEY); } catch (error) {}
      return;
    }
    restoreDay(currentDay());
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
    loadRuntimeModule('memory-tools.js?v=1.0.0-transcript3', 'data-synap-memory-tools', function () {
      return Boolean(root.SynapMemoryTools);
    });
    loadRuntimeModule('cost-ui.js?v=1.0.0-cost1', 'data-synap-cost-ui', function () {
      return Boolean(root.SynapCostUI);
    });
  }

  /* Retained as an explicit/manual compatibility surface, but no lifecycle hook
     calls it automatically anymore. */
  function refreshVisible() {
    if (!signedIn() || busy()) return Promise.resolve({ restored: 0, updated: 0 });
    return restoreDay(currentDay());
  }

  function recordingIdFromCard(target) {
    if (!target) return '';
    var id = String(target.id || '').replace(/^recording-/, '');
    if (id && id !== target.id) return id;
    return String(target.dataset && target.dataset.recordingId || '');
  }

  function bindEventDrivenRefresh() {
    if (!root.document || typeof root.document.addEventListener !== 'function') return;

    root.document.addEventListener('change', function (event) {
      var target = event && event.target;
      if (!target || target.id !== 'datePicker' || event.__synapCloudInternal) return;
      restoreDay(target.value || currentDay());
    });

    root.document.addEventListener('toggle', function (event) {
      var target = event && event.target;
      if (!target || !target.classList || !target.classList.contains('recording-card') || !target.open) return;
      var id = recordingIdFromCard(target);
      if (id) restoreRecording(id, false);
    }, true);

    root.document.addEventListener('click', function (event) {
      var button = event && event.target && event.target.closest
        ? event.target.closest('.synap-memory-tabs button')
        : null;
      if (!button || String(button.textContent || '').trim() !== 'Transcript') return;
      var card = button.closest('.insight-card[data-recording-id]');
      if (card && card.dataset.recordingId) restoreRecording(card.dataset.recordingId, false);
    }, true);

    if (typeof root.addEventListener === 'function') {
      root.addEventListener('synap-memory-ready', function (event) {
        var id = event && event.detail && event.detail.recordingId;
        if (id) restoreRecording(id, true);
      });
      root.addEventListener('synap-recording-opened', function (event) {
        var id = event && event.detail && event.detail.recordingId;
        if (id) restoreRecording(id, false);
      });
    }
  }

  function init() {
    loadProductRuntime();
    bindEventDrivenRefresh();
    if (root.SynapAuth && typeof root.SynapAuth.onChange === 'function') {
      root.SynapAuth.onChange(onAuthChange);
    }
    if (signedIn()) restoreDay(currentDay());
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
    restoreDay: restoreDay,
    restoreRecording: restoreRecording,
    toLocal: toLocal,
    merge: merge,
    plan: plan,
    busy: busy,
    meaningfullyChanged: meaningfullyChanged,
    refreshUiInPlace: refreshUiInPlace,
    loadTranscriptRepair: loadTranscriptRepair,
    loadProductRuntime: loadProductRuntime,
    refreshVisible: refreshVisible,
    currentDay: currentDay,
    bindEventDrivenRefresh: bindEventDrivenRefresh
  };
})(globalThis);
