/* Rebuild this device's journal from the account's cloud memory.
 *
 * Everything the app renders — Library, Today, People, follow-ups, search —
 * comes from the local IndexedDB journal, which is per-device. Sign in on a
 * second phone and the app looked empty even though every memory was sitting
 * sealed in Firestore. Signing out clears the journal, so the same thing
 * happened on the original phone after a sign-out and back in. The data was
 * never lost; nothing ever asked for it.
 *
 * The rules here are deliberately conservative, because the local journal is
 * the only copy of anything not yet uploaded:
 *
 *   - nothing local is ever deleted;
 *   - audio is never touched, and a restored recording has none (cloud audio
 *     expires after 30 days and is not downloadable), so the Library simply
 *     offers no playback for it;
 *   - a field already present locally always wins, so a recording still being
 *     captured or uploaded on this device cannot be overwritten by an older
 *     cloud copy.
 *
 * Running twice is a no-op, which is what makes the reload at the end safe.
 */
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

  /* Use the app's own store rather than opening IndexedDB directly.
     audio-store.js owns this database and opens it at version 3; a bare
     indexedDB.open() here would race it and, on a browser that has never run
     Synap, could create a version-1 database with no object stores at all. */
  function store() {
    if (!root.DKAudioStore) return Promise.reject(new Error('journal unavailable'));
    var journal = new root.DKAudioStore({ onError: function () {} });
    return journal.open().then(function () { return journal; });
  }

  /* Local wins on every field it already has. The cloud copy is a backup of
     what this device may have forgotten, never a correction of what it knows. */
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

  /* Map one cloud recording onto the local record shape. toRecordingFields is
     the same mapper the live processing path uses, so a restored memory is
     indistinguishable from one built on this device. */
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
      // No audio: the bytes are not retrievable, and claiming otherwise would
      // give the user a Play button that fails.
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
    // A recording still processing in the cloud is shown as pending rather than
    // as a finished memory with nothing in it.
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

  /* When to spend the user's data.
   *
   * An empty journal is the case this exists for — a new device, or this one
   * after a sign-out — and it is worth a full pull including transcripts.
   *
   * A journal that already has recordings only needs to hear about ones made
   * elsewhere, so it syncs metadata once per session and leaves transcripts
   * behind; they are large, and the recordings that need them were almost
   * always made on this device. Without this, opening the app re-downloaded
   * every transcript over mobile data to learn that nothing had changed. */
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
        // Writing an identical record would churn the store and, worse, make
        // the reload below fire on every load.
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
      // History is a convenience. Failing to restore it must never stop the app
      // from recording, which is the thing that cannot be redone later.
      console.warn('[synap history] could not restore from cloud', error);
      return { restored: 0, updated: 0, error: error };
    });
  }

  /* The views read the journal once at startup and re-render from their own
     caches, so newly written rows are not picked up in place. A reload is the
     same approach sign-out already takes, and it is honest: the app genuinely
     has different data than when the page loaded.
     The guard makes a reload loop impossible even if a write somehow repeats. */
  function restoreAndShow(force) {
    return restore(force).then(function (result) {
      var changed = (result.restored || 0) + (result.updated || 0);
      if (!changed) return result;

      var reloaded = false;
      try { reloaded = root.sessionStorage.getItem(GUARD_KEY) === '1'; } catch (error) {}
      if (reloaded || !root.location || typeof root.location.reload !== 'function') return result;
      // Signing in mid-capture is entirely normal — the account panel is where
      // people go when processing is stuck. Reloading then would destroy the
      // take in progress, which is the one thing that cannot be redone. The
      // restored rows are already written; they appear on the next load.
      if (busy()) return result;

      try { root.sessionStorage.setItem(GUARD_KEY, '1'); } catch (error) {}
      root.setTimeout(function () { root.location.reload(); }, 400);
      return result;
    });
  }

  /* Mirrors the risky states enhancements.js already refuses to act during. */
  var BUSY = ['recording', 'starting', 'stopping', 'saving', 'updating'];

  function busy() {
    var state = root.document && root.document.body && root.document.body.dataset
      ? root.document.body.dataset.state
      : '';
    return BUSY.indexOf(String(state || '')) !== -1;
  }

  function onAuthChange(session) {
    if (!session || !session.refreshToken) {
      // A new sign-in on this device should be allowed to restore again.
      try {
        root.sessionStorage.removeItem(GUARD_KEY);
        root.sessionStorage.removeItem(SYNCED_KEY);
      } catch (error) {}
      return;
    }
    // A sign-in is exactly when history should come back, whatever this
    // session has already synced.
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
