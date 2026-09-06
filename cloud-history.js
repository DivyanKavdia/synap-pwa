/* Restore account memory into the local recording journal. */
(function (root) {
  'use strict';

  var DB = 'dk-pendant-recordings';
  var STORE = 'recordings';
  var LIMIT = 100;
  var GUARD_KEY = 'synap-cloud-history-reloaded';
  var SYNCED_KEY = 'synap-cloud-history-synced';
  var running = false;

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

  // Preserve local fields; cloud only fills gaps.
  function merge(local, restored) {
    var merged = Object.assign({}, restored, local);
    if (local) {
      Object.keys(restored).forEach(function (key) {
        var current = local[key];
        var empty = current === undefined || current === null || current === '' ||
          (Array.isArray(current) && current.length === 0);
        if (empty && restored[key] !== undefined) merged[key] = restored[key];
      });
    }
    return merged;
  }

  function toLocal(item) {
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
      var fields = api.toRecordingFields(item);
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
      return api.recordings({ limit: LIMIT, transcript: choice.transcript })
        .then(function (result) { return [locals, result]; });
    }).then(function (results) {
      var locals = results[0];
      var remote = (results[1] && results[1].recordings) || [];
      var byId = new Map();
      locals.forEach(function (record) { if (record && record.id) byId.set(String(record.id), record); });

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
        if (JSON.stringify(merged) !== JSON.stringify(local)) {
          writes.push(merged);
          updated += 1;
        }
      });

      if (!writes.length) return { restored: 0, updated: 0 };
      return write(db, writes).then(function () { return { restored: restored, updated: updated }; });
    }).then(function (result) {
      running = false;
      return result;
    }).catch(function (error) {
      running = false;
      console.warn('[synap history] could not restore from cloud', error);
      return { restored: 0, updated: 0, error: error };
    });
  }

  function restoreAndShow(force) {
    return restore(force).then(function (result) {
      var changed = (result.restored || 0) + (result.updated || 0);
      if (!changed) return result;

      var reloaded = false;
      try { reloaded = root.sessionStorage.getItem(GUARD_KEY) === '1'; } catch (error) {}
      if (reloaded || !root.location || typeof root.location.reload !== 'function') return result;
      if (busy()) return result;

      try { root.sessionStorage.setItem(GUARD_KEY, '1'); } catch (error) {}
      root.setTimeout(function () { root.location.reload(); }, 400);
      return result;
    });
  }

  var BUSY = ['recording', 'starting', 'stopping', 'saving', 'updating'];

  function busy() {
    var state = root.document && root.document.body && root.document.body.dataset
      ? root.document.body.dataset.state
      : '';
    return BUSY.indexOf(String(state || '')) !== -1;
  }

  function onAuthChange(session) {
    if (!session || !session.refreshToken) {
      try {
        root.sessionStorage.removeItem(GUARD_KEY);
        root.sessionStorage.removeItem(SYNCED_KEY);
      } catch (error) {}
      return;
    }
    restoreAndShow(true);
  }

  function init() {
    if (root.SynapAuth && typeof root.SynapAuth.onChange === 'function') {
      root.SynapAuth.onChange(onAuthChange);
    }
    if (signedIn()) restoreAndShow();
  }

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  root.SynapCloudHistory = { restore: restore, restoreAndShow: restoreAndShow, toLocal: toLocal, merge: merge, plan: plan, busy: busy };
})(globalThis);
