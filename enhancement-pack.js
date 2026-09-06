/* Synap rolling capture + account privacy enhancement pack.
 *
 * Internal PCM/transcription windows stay at the proven 30-second geometry.
 * Completed windows are sealed and queued while capture continues. Two adjacent
 * windows are exposed as one logical source WAV, so source files are <=60 sec
 * without duplicating audio in IndexedDB.
 */
(function (root) {
  'use strict';

  const TRANSCRIPTION_FRAMES = 600; // 30 s at 50 ms/frame; matches audio-store.js.
  const SOURCE_FILE_SEGMENTS = 2;
  const SOURCE_FILE_MS = 60 * 1000;
  const PROCESSORS = new Set();
  const INSTALL_POLL_MS = 40;
  const AUTH_POLL_MS = 50;
  const DB_NAME = 'dk-pendant-recordings';

  function currentUid() {
    try {
      const session = root.SynapAuth && root.SynapAuth.session && root.SynapAuth.session();
      return String(session && session.profile && session.profile.uid || '');
    } catch (_) { return ''; }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const request = root.indexedDB.open(DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function claimLegacyRecordings(uid) {
    if (!uid || !root.indexedDB) return;
    const marker = 'synap-owner-migration-v1:' + uid;
    try { if (root.localStorage.getItem(marker) === 'done') return; } catch (_) {}
    const db = await openDb();
    try {
      if (!db.objectStoreNames.contains('recordings')) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction('recordings', 'readwrite');
        const store = tx.objectStore('recordings');
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const hit = cursor.result;
          if (!hit) return;
          const value = hit.value || {};
          if (!value.ownerUid) hit.update(Object.assign({}, value, { ownerUid: uid }));
          hit.continue();
        };
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Owner migration failed'));
      });
      try { root.localStorage.setItem(marker, 'done'); } catch (_) {}
    } finally { try { db.close(); } catch (_) {} }
  }

  async function ownerOf(recordingId) {
    if (!recordingId || !root.indexedDB) return '';
    const db = await openDb();
    try {
      if (!db.objectStoreNames.contains('recordings')) return '';
      return await new Promise((resolve, reject) => {
        const request = db.transaction('recordings').objectStore('recordings').get(recordingId);
        request.onsuccess = () => resolve(String(request.result && request.result.ownerUid || ''));
        request.onerror = () => reject(request.error);
      });
    } finally { try { db.close(); } catch (_) {} }
  }

  function installAudioPatch() {
    const Store = root.DKAudioStore;
    const Processor = root.DKFIFOProcessor;
    const codec = root.DKAudioCodec;
    if (!Store || !Processor || !codec || !codec.assemble || Store.prototype.__synapRolling30) return false;

    const originalBegin = Store.prototype.begin;
    const originalAppend = Store.prototype.append;
    const originalClose = Store.prototype.close;
    const originalResume = Processor.prototype.resume;

    Store.prototype.begin = async function (name, association) {
      const id = await originalBegin.call(this, name, association);
      await this.atomic(['recordings'], (stores) => {
        const request = stores.recordings.get(id);
        request.onsuccess = () => {
          if (!request.result) return;
          stores.recordings.put(Object.assign({}, request.result, {
            ownerUid: currentUid() || null,
            transcriptionWindowSeconds: 30,
            sourceFileSeconds: 60,
            rollingTranscription: true
          }));
        };
      });
      return id;
    };

    function sealCompletedWindow(store, recordingId, index) {
      if (!Number.isInteger(index) || index < 0) return;
      store.__synapRollingSeal = (store.__synapRollingSeal || Promise.resolve()).then(async () => {
        await store.flush();
        const meta = await store.get('segments', [recordingId, index]);
        if (meta && meta.pcmBlob) return;
        const packets = await store.all('packets', 'segment', [recordingId, index]);
        if (!packets.length) return;
        const start = index * TRANSCRIPTION_FRAMES;
        const end = start + TRANSCRIPTION_FRAMES - 1;
        const data = codec.assemble(packets, {
          preserveTimeline: true,
          startSequence: start,
          endSequence: end
        });
        if (!data.completeFrames) return;
        await store.compactSegment(recordingId, index, data);
        root.dispatchEvent(new CustomEvent('synap-transcription-window-ready', {
          detail: { recordingId: recordingId, segmentIndex: index, startMs: index * 30000, endMs: (index + 1) * 30000 }
        }));
      }).catch((error) => {
        try { store.onError(error); } catch (_) {}
      });
    }

    Store.prototype.append = function (recordingId, packet) {
      originalAppend.call(this, recordingId, packet);
      const index = Math.floor(packet.sequence / TRANSCRIPTION_FRAMES);
      this.__synapRollingIndex = this.__synapRollingIndex || new Map();
      const previous = this.__synapRollingIndex.get(recordingId);
      if (Number.isInteger(previous) && index > previous) sealCompletedWindow(this, recordingId, previous);
      this.__synapRollingIndex.set(recordingId, index);
    };

    Store.prototype.close = async function (recordingId, reason) {
      await (this.__synapRollingSeal || Promise.resolve());
      const saved = await originalClose.call(this, recordingId, reason);
      if (!saved) return saved;
      const sourceFileCount = saved.durationMs ? Math.ceil(saved.durationMs / SOURCE_FILE_MS) : 0;
      await this.atomic(['recordings'], (stores) => {
        const request = stores.recordings.get(recordingId);
        request.onsuccess = () => {
          if (!request.result) return;
          stores.recordings.put(Object.assign({}, request.result, {
            transcriptionWindowSeconds: 30,
            sourceFileSeconds: 60,
            sourceFileCount: sourceFileCount,
            rollingTranscription: true
          }));
        };
      });
      if (this.__synapRollingIndex) this.__synapRollingIndex.delete(recordingId);
      return this.get('recordings', recordingId);
    };

    async function pcmForSegment(store, recordingId, segment) {
      if (segment.pcmBlob) return new Uint8Array(await segment.pcmBlob.arrayBuffer());
      const packets = await store.all('packets', 'segment', [recordingId, segment.index]);
      if (!packets.length) return null;
      const scan = codec.assemble(packets);
      if (scan.lastSequence < 0) return null;
      const start = segment.index * TRANSCRIPTION_FRAMES;
      const data = codec.assemble(packets, {
        preserveTimeline: true,
        startSequence: start,
        endSequence: scan.lastSequence
      });
      return data.frames.length ? new Uint8Array(await new Blob(data.frames).arrayBuffer()) : null;
    }

    Store.prototype.sourceFiles = async function (record) {
      if (!record || !record.id) return [];
      const segments = (await this.all('segments', 'recording', record.id))
        .filter((segment) => segment && (segment.pcmBlob || segment.frameCount))
        .sort((a, b) => a.index - b.index);
      if (!segments.length && record.blob) {
        return [{ index: 0, startMs: 0, endMs: record.durationMs || 0, durationMs: record.durationMs || 0, blob: record.blob }];
      }
      const files = [];
      for (let offset = 0; offset < segments.length; offset += SOURCE_FILE_SEGMENTS) {
        const group = segments.slice(offset, offset + SOURCE_FILE_SEGMENTS);
        const pcm = [];
        for (const segment of group) {
          const bytes = await pcmForSegment(this, record.id, segment);
          if (bytes && bytes.byteLength) pcm.push(bytes);
        }
        if (!pcm.length) continue;
        const firstIndex = group[0].index;
        const startMs = firstIndex * 30000;
        const durationMs = Math.min(SOURCE_FILE_MS, Math.max(0, (record.durationMs || startMs + SOURCE_FILE_MS) - startMs));
        files.push({
          index: files.length,
          startMs: startMs,
          endMs: startMs + durationMs,
          durationMs: durationMs,
          blob: codec.wav(pcm)
        });
      }
      return files;
    };

    Processor.prototype.resume = function () {
      PROCESSORS.add(this);
      return originalResume.apply(this, arguments);
    };

    root.addEventListener('synap-transcription-window-ready', () => {
      PROCESSORS.forEach((processor) => {
        try { if (!processor.paused && processor.canRun()) processor.run(); } catch (_) {}
      });
    });

    Store.prototype.__synapRolling30 = true;
    return true;
  }

  function installPrivacyUi() {
    if (!root.document || root.document.getElementById('synapAccountPrivacyStyle')) return;
    const style = root.document.createElement('style');
    style.id = 'synapAccountPrivacyStyle';
    style.textContent = [
      'body[data-synap-account-state="signed-out"] #today .day-brief,',
      'body[data-synap-account-state="signed-out"] #insights,',
      'body[data-synap-account-state="signed-out"] #library,',
      'body[data-synap-account-state="signed-out"] #processing{display:none!important}',
      '.synap-signed-out-note{margin:1rem 0;padding:.8rem 1rem;border:1px solid var(--border);border-radius:14px;background:var(--surface-2);font-size:.82rem;line-height:1.45}',
      '.transcript-preview[open]>summary{font-weight:700}'
    ].join('');
    root.document.head.appendChild(style);

    const note = root.document.createElement('p');
    note.id = 'synapSignedOutPrivacyNote';
    note.className = 'synap-signed-out-note';
    note.textContent = 'Sign in to view your recordings, transcripts and memories.';
    note.hidden = true;
    const capture = root.document.getElementById('capture');
    if (capture) capture.insertAdjacentElement('beforebegin', note);

    async function filterRecordingCards(uid) {
      const cards = Array.from(root.document.querySelectorAll('.recording-card'));
      await Promise.all(cards.map(async (card) => {
        const id = String(card.id || '').replace(/^recording-/, '');
        if (!id) return;
        const owner = await ownerOf(id).catch(() => '');
        card.hidden = !uid || !owner || owner !== uid;
      }));
    }

    function makeTranscriptsVisible() {
      root.document.querySelectorAll('details.transcript-preview').forEach((details) => { details.open = true; });
      root.document.querySelectorAll('.recording-card details').forEach((details) => {
        const heading = details.querySelector(':scope > summary');
        if (heading && /^transcript$/i.test(heading.textContent.trim())) details.open = true;
      });
    }

    let activeUid = '';
    const observer = new MutationObserver(() => {
      makeTranscriptsVisible();
      if (activeUid) filterRecordingCards(activeUid).catch(() => {});
    });
    observer.observe(root.document.body, { childList: true, subtree: true });

    async function applySession(session) {
      const uid = String(session && session.profile && session.profile.uid || '');
      activeUid = uid;
      root.document.body.dataset.synapAccountState = uid ? 'signed-in' : 'signed-out';
      note.hidden = Boolean(uid);
      if (!uid) {
        PROCESSORS.forEach((processor) => { try { processor.pause(); } catch (_) {} });
        const search = root.document.querySelector('.memory-results');
        if (search) search.replaceChildren();
        return;
      }
      await claimLegacyRecordings(uid).catch(() => {});
      await filterRecordingCards(uid).catch(() => {});
      makeTranscriptsVisible();
    }

    let attempts = 0;
    const timer = root.setInterval(() => {
      if (root.SynapAuth && typeof root.SynapAuth.onChange === 'function') {
        root.clearInterval(timer);
        root.SynapAuth.onChange(applySession);
      } else if (++attempts > 400) {
        root.clearInterval(timer);
        applySession(null);
      }
    }, AUTH_POLL_MS);
  }

  function boot() {
    installPrivacyUi();
    if (installAudioPatch()) return;
    let attempts = 0;
    const timer = root.setInterval(() => {
      if (installAudioPatch() || ++attempts > 400) root.clearInterval(timer);
    }, INSTALL_POLL_MS);
  }

  if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  root.SynapEnhancementPack = {
    TRANSCRIPTION_FRAMES: TRANSCRIPTION_FRAMES,
    SOURCE_FILE_SEGMENTS: SOURCE_FILE_SEGMENTS,
    SOURCE_FILE_MS: SOURCE_FILE_MS,
    installAudioPatch: installAudioPatch
  };
})(globalThis);
