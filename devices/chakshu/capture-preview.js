/* Immediate feedback for header captures. Preview reads only already-saved camera frames. */
(function (root) {
  'use strict';
  const $ = (id) => document.getElementById(id),
    api = () => root.SynapChakshu;
  let owner = '',
    mode = '',
    mediaId = null,
    epoch = 0,
    rendering = 0,
    busy = false,
    sdCapture = false,
    url = null,
    frameKey = '',
    note = '';
  function release() {
    if (url) URL.revokeObjectURL(url);
    url = null;
    frameKey = '';
    $('capturePreviewImage').removeAttribute('src');
    $('capturePreviewImage').hidden = true;
  }
  function close() {
    ++epoch;
    ++rendering;
    $('capturePreview').close();
    release();
    mediaId = null;
    mode = '';
    sdCapture = false;
    owner = '';
    note = '';
  }
  function begin(kind) {
    close();
    owner = api().state.owner;
    mode = kind;
    busy = true;
    $('capturePreviewTitle').textContent = kind === 'video' ? 'Video preview' : 'Photo preview';
    $('capturePreviewStatus').textContent =
      kind === 'video' ? 'Preparing video and separate audio…' : 'Taking photo…';
    $('capturePreviewWaiting').hidden = false;
    $('capturePreviewWaiting').textContent = 'Waiting for the camera…';
    $('capturePreviewHint').textContent = '';
    for (const id of ['capturePreviewPhoto', 'capturePreviewStop', 'capturePreviewOpen'])
      $(id).disabled = true;
    $('capturePreviewPhoto').hidden = true;
    $('capturePreviewStop').hidden = kind !== 'video';
    $('capturePreviewOpen').hidden = true;
    $('capturePreview').showModal();
    return epoch;
  }
  async function render() {
    if (!$('capturePreview').open) return;
    const state = api().state;
    if (state.owner !== owner || !state.available) {
      close();
      return;
    }
    const token = ++rendering,
      generation = epoch,
      store = api().store;
    if (mode === 'video' && state.session?.id) mediaId = state.session.id;
    const id = mediaId;
    const [row, frame] = id
      ? await Promise.all([store.get(id), store.lastFrame(id)])
      : [null, null];
    if (
      token !== rendering ||
      generation !== epoch ||
      owner !== api().state.owner ||
      store !== api().store
    )
      return;
    if (frame && frameKey !== id + ':' + frame.index) {
      release();
      url = URL.createObjectURL(frame.blob);
      frameKey = id + ':' + frame.index;
      $('capturePreviewImage').src = url;
      $('capturePreviewImage').hidden = false;
    }
    $('capturePreviewWaiting').hidden = Boolean(frame);
    const active = mode === 'video' && Boolean(state.session || state.offline);
    const receiving =
      state.transferProgress && !state.error
        ? state.transferProgress.totalBytes
          ? 'Receiving camera image · ' + state.transferProgress.percent + '%'
          : 'Taking camera image…'
        : '';
    const stopping = state.session?.phase === 'saving';
    if (mode === 'video' && state.offline) sdCapture = true;
    const sd = sdCapture && !mediaId && !state.session && state.offlineStatus;
    $('capturePreviewWaiting').textContent =
      state.error ||
      note ||
      (sd
        ? state.offline
          ? 'Video is recording on the SD card.'
          : 'SD recording finished.'
        : '') ||
      receiving ||
      (active ? 'Waiting for the first video frame…' : 'No camera image yet.');
    $('capturePreviewStatus').textContent =
      note ||
      state.error ||
      (sd
        ? state.offline
          ? 'Recording to SD · ' +
            root.SynapChakshuPlayer.timeLabel(sd.audioMs || 0) +
            ' · ' +
            (sd.frames || 0) +
            ' frames'
          : sd.error
            ? 'Partial recording kept on SD.'
            : 'Video and audio saved to SD.'
        : stopping
          ? 'Saving video and audio…'
          : receiving
            ? receiving
            : active
              ? frame
                ? 'Recording · ' + root.SynapChakshuPlayer.timeLabel(frame.atMs)
                : 'Preparing video and separate audio…'
              : row
                ? row.kind === 'video'
                  ? 'Video saved with audio in your memory library.'
                  : row.previewOnly
                    ? 'Preview saved here. Original photo saved to SD.'
                    : 'Photo saved to your library.'
                : busy
                  ? 'Taking photo…'
                  : 'Capture unavailable.');
    $('capturePreviewHint').textContent = active
      ? stopping
        ? 'Finishing the recording and saving received frames and audio…'
        : 'Closing this preview keeps recording. Use Stop & save video to finish.'
      : sd
        ? 'Open Photos & video in Library to move this recording to the app or download it over Wi-Fi.'
        : row
          ? 'You can review this capture in your library.'
          : '';
    $('capturePreviewPhoto').hidden = mode !== 'video' || !active || Boolean(sd);
    $('capturePreviewPhoto').disabled =
      busy || state.working || state.session?.phase !== 'recording';
    $('capturePreviewStop').hidden = !active;
    $('capturePreviewStop').disabled = busy || stopping || state.session?.phase === 'starting';
    $('capturePreviewOpen').hidden = !row || active;
    $('capturePreviewOpen').disabled = busy || active || !row;
  }
  async function capturePhoto() {
    const token = begin('image');
    try {
      const id = await api().photo();
      if (token === epoch && owner === api().state.owner) mediaId = id;
      return id;
    } catch (error) {
      if (token === epoch) note = error.message;
      throw error;
    } finally {
      if (token === epoch) {
        busy = false;
        await render();
      }
    }
  }
  async function captureVideo() {
    const token = begin('video');
    const current = api().state;
    mediaId = current.session?.id || null;
    try {
      if (current.session || current.offline) await api().stop();
      else await (api().startVideo ? api().startVideo() : api().startLive(false));
    } catch (error) {
      if (token === epoch) note = error.message;
      throw error;
    } finally {
      if (token === epoch) {
        busy = false;
        await render();
      }
    }
  }
  async function act(fn, success = '') {
    if (busy) return;
    const token = epoch;
    busy = true;
    note = '';
    try {
      await render();
      if (token !== epoch || owner !== api().state.owner) return;
      await fn();
      if (token === epoch) note = success;
    } catch (error) {
      if (token === epoch) note = error.message;
    } finally {
      if (token === epoch) {
        busy = false;
        await render();
      }
    }
  }
  function init() {
    $('capturePreviewClose').addEventListener('click', close);
    $('capturePreview').addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    $('capturePreviewPhoto').addEventListener('click', () =>
      act(() => api().photo(), 'Photo saved to your library. Video continues recording.'),
    );
    $('capturePreviewStop').addEventListener('click', () => act(() => api().stop()));
    $('capturePreviewOpen').addEventListener('click', () =>
      act(async () => {
        const id = mediaId,
          token = epoch;
        await root.SynapChakshuLibrary.open(id);
        if (token === epoch) close();
      }),
    );
    root.addEventListener('synap-chakshu-changed', () =>
      render().catch((error) => {
        if ($('capturePreview').open) $('capturePreviewStatus').textContent = error.message;
      }),
    );
  }
  root.SynapChakshuPreview = { photo: capturePhoto, video: captureVideo, close };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);

/* Chakshu v2 lifecycle: verified move-from-SD, FIFO controls and explicit vision. */
(function (root) {
  'use strict';
  const api = () => root.SynapChakshu;
  const RECEIPT_PREFIX = 'synap-chakshu-move-v2:';
  let busy = false;
  const status = (message) => {
    const node = document.getElementById('visualConnectionStatus'),
      inbox = document.getElementById('librarySDInboxText');
    if (node) node.textContent = message || '';
    if (inbox && message) inbox.textContent = message;
  };
  function context() {
    const state = api()?.state,
      connection = root.SynapDevices?.connection;
    if (!state?.available) throw Error('Associate Chakshu with this account first.');
    if (!state.connected || !connection?.deviceId) throw Error(state?.connectionStatus?.message || 'Connect Chakshu first.');
    if (!state.mediaSupported) throw Error('Update Chakshu firmware for media controls.');
    return connection;
  }
  function client() {
    return new root.SynapChakshuTransfer.Client(context());
  }
  function pathOk(path) {
    return /^\/synap\/[a-f0-9]{8}-[a-f0-9]{8}\.(jpg|wav|mjpeg|json)$/.test(path);
  }
  async function digest(blob) {
    const bytes = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const basename = (path) => path.split('/').pop();
  const stem = (path) => path.replace(/\.[^.]+$/, '');
  const receiptKey = (deviceId, path) => RECEIPT_PREFIX + deviceId + ':' + path;
  function audioJournal() {
    return new root.DKAudioStore({ ...root.SynapRecordingJournal.options() });
  }
  async function localSnapshot() {
    const visuals = api().store ? await api().store.list() : [];
    const recordings = await audioJournal().all('recordings');
    return {
      visuals: new Set(visuals.map((row) => row.id)),
      recordings: new Set(recordings.map((row) => row.id)),
    };
  }
  async function download(path, signal, progress) {
    if (!pathOk(path)) throw Error('Invalid SD path.');
    const c = client(),
      files = [];
    const add = async (name, required = true) => {
      try {
        const blob = await c.file(name, signal, progress);
        const type = name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.wav') ? 'audio/wav' : name.endsWith('.json') ? 'application/json' : 'video/x-motion-jpeg';
        files.push(new File([blob], basename(name), { type }));
        return blob;
      } catch (error) {
        if (!required && /SD file unavailable/.test(error.message)) return null;
        throw error;
      }
    };
    const main = await add(path);
    let wav = null;
    if (path.endsWith('.mjpeg')) {
      await add(stem(path) + '.json', false);
      wav = await add(stem(path) + '.wav', false);
    }
    return { files, main, wav };
  }
  async function verifyVisual(id, expectedMain, expectedWav) {
    const store = api().store,
      row = await store.get(id);
    if (!row || row.state !== 'saved') throw Error('The imported visual was not durably saved.');
    const frames = await store.frames(id),
      rebuilt = new Blob(frames.map((frame) => frame.blob), {
        type: row.kind === 'image' ? 'image/jpeg' : 'video/x-motion-jpeg',
      });
    if (rebuilt.size !== expectedMain.size || (await digest(rebuilt)) !== (await digest(expectedMain)))
      throw Error('The saved visual did not match the SD source. The SD original was kept.');
    if (expectedWav) {
      if (!row.audioId) throw Error('The video soundtrack was not saved. The SD original was kept.');
      const journal = audioJournal(),
        record = await journal.get('recordings', row.audioId);
      if (!record || !record.sealed) throw Error('The video soundtrack is still saving. The SD original was kept.');
      const saved = await journal.blob(record);
      if (saved.size !== expectedWav.size || (await digest(saved)) !== (await digest(expectedWav)))
        throw Error('The saved soundtrack did not match the SD source. The SD original was kept.');
    }
    return row;
  }
  async function verifyAudio(id, expected) {
    const journal = audioJournal(),
      record = await journal.get('recordings', id);
    if (!record || !record.sealed) throw Error('The imported audio is still saving. The SD original was kept.');
    const saved = await journal.blob(record);
    if (saved.size !== expected.size || (await digest(saved)) !== (await digest(expected)))
      throw Error('The saved audio did not match the SD source. The SD original was kept.');
    return record;
  }
  async function verifyReceipt(receipt) {
    if (!receipt || receipt.owner !== api().state.owner || receipt.deviceId !== root.SynapDevices?.connection?.deviceId)
      return false;
    try {
      if (receipt.visualId) {
        const row = await api().store.get(receipt.visualId);
        if (!row || row.state !== 'saved') return false;
        const frames = await api().store.frames(receipt.visualId),
          rebuilt = new Blob(frames.map((frame) => frame.blob));
        if (rebuilt.size !== receipt.mainBytes || (await digest(rebuilt)) !== receipt.mainSha256) return false;
      }
      if (receipt.audioId) {
        const journal = audioJournal(),
          record = await journal.get('recordings', receipt.audioId);
        if (!record || !record.sealed) return false;
        const blob = await journal.blob(record);
        if (blob.size !== receipt.audioBytes || (await digest(blob)) !== receipt.audioSha256) return false;
      }
      return Boolean(receipt.visualId || receipt.audioId);
    } catch (_) {
      return false;
    }
  }
  async function deleteSD(path, optional = false) {
    try {
      const reply = await client().request(17, 0, path);
      return reply.total;
    } catch (error) {
      if (optional && /SD file unavailable/.test(error.message)) return 0;
      throw error;
    }
  }
  async function deleteSyncedSet(path) {
    // Delete video companions first. If cleanup is interrupted, keeping the
    // MJPEG primary prevents its soundtrack from surfacing as standalone audio.
    if (path.endsWith('.mjpeg')) {
      await deleteSD(stem(path) + '.json', true);
      await deleteSD(stem(path) + '.wav', true);
    }
    return deleteSD(path);
  }
  async function moveSD(path, progress = () => {}) {
    if (busy) throw Error('Another Chakshu transfer is already running.');
    const connection = context(),
      owner = api().state.owner,
      key = receiptKey(connection.deviceId, path);
    busy = true;
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (await verifyReceipt(cached)) {
        await deleteSyncedSet(path);
        localStorage.removeItem(key);
        root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
        return cached;
      }
      localStorage.removeItem(key);
      const before = await localSnapshot(),
        source = await download(path, undefined, progress),
        mainSha = await digest(source.main),
        wavSha = source.wav ? await digest(source.wav) : null;
      if (owner !== api().state.owner || connection !== root.SynapDevices?.connection)
        throw Error('Account or pendant changed during transfer. The SD original was kept.');
      await api().importFiles(source.files, connection.deviceId);
      const rows = await api().store.list(),
        journal = audioJournal(),
        recordings = await journal.all('recordings');
      let visualId = null,
        audioId = null;
      if (/\.(jpg|mjpeg)$/.test(path)) {
        const row = rows
          .filter((item) => !before.visuals.has(item.id) && item.sourceName === basename(path))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        if (!row) throw Error('The imported visual could not be verified. The SD original was kept.');
        await verifyVisual(row.id, source.main, source.wav);
        visualId = row.id;
        audioId = row.audioId || null;
      } else if (path.endsWith('.wav')) {
        const record = recordings
          .filter((item) => !before.recordings.has(item.id) && item.ownerUid === owner)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        if (!record) throw Error('The imported audio could not be verified. The SD original was kept.');
        await verifyAudio(record.id, source.main);
        audioId = record.id;
      } else throw Error('Move the primary photo, video or audio file instead.');
      const receipt = {
        schema: 1,
        owner,
        deviceId: connection.deviceId,
        path,
        visualId,
        audioId,
        mainBytes: source.main.size,
        mainSha256: mainSha,
        ...(source.wav
          ? { audioBytes: source.wav.size, audioSha256: wavSha }
          : path.endsWith('.wav')
            ? { audioBytes: source.main.size, audioSha256: mainSha }
            : {}),
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(key, JSON.stringify(receipt));
      await deleteSyncedSet(path);
      localStorage.removeItem(key);
      root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
      return receipt;
    } finally {
      busy = false;
    }
  }
  async function clearSD() {
    if (busy) throw Error('Another Chakshu transfer is already running.');
    const connection = context();
    if (api().state.offline || api().state.session || root.SynapAppControls.recordingState().active)
      throw Error('Stop recording before clearing the SD card.');
    busy = true;
    try {
      const reply = await client().request(18);
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key?.startsWith(RECEIPT_PREFIX + connection.deviceId + ':')) localStorage.removeItem(key);
      }
      await api().refreshSD().catch(() => {});
      return reply.total || 0;
    } finally {
      busy = false;
    }
  }
  async function settleAudio() {
    const current = root.SynapAppControls.recordingState();
    if (!current.active) return;
    await root.SynapAppControls.stopCapture(current.sessionId);
    const deadline = Date.now() + 15000;
    while (root.SynapAppControls.recordingState().active || root.SynapAppControls.recordingState().settling) {
      if (Date.now() >= deadline) throw Error('Audio is still saving. Retry after it finishes.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async function startOffline(profile = 0, seconds = 10) {
    void profile; void seconds;
    throw Error('Offline SD capture is device-owned and runs only while Chakshu is disconnected from the PWA.');
  }

  async function startOfflineAudio(seconds = 600) {
    void seconds;
    throw Error('Offline SD capture is device-owned and runs only while Chakshu is disconnected from the PWA.');
  }

  async function describeNow() {
    if (busy || api().state.busy) throw Error('Finish the current capture or transfer first.');
    const connection = context(),
      owner = api().state.owner;
    if (!api().state.storageReady) throw Error('Insert an SD card to keep the full-quality photo.');
    busy = true;
    try {
      const transfer = new root.SynapChakshuTransfer.Client(connection),
        saved = await transfer.savedPreview();
      const receipt = await (async () => {
        busy = false;
        try {
          return await moveSD(saved.path);
        } finally {
          busy = true;
        }
      })();
      if (!receipt.visualId) throw Error('The photo was not saved in Memory.');
      if (owner !== api().state.owner) throw Error('Account changed before visual inference.');
      const response = await root.SynapAuth.authedFetch('/v1/chakshu/describe', {
        method: 'POST',
        expectedUid: owner,
        headers: { 'Content-Type': 'image/jpeg' },
        body: saved.blob,
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error?.message || 'The photo could not be described.');
      const text = String(data.description || '').trim();
      if (!text) throw Error('The image service returned no description.');
      await api().store.addDescription(receipt.visualId, {
        text: text.slice(0, 2000),
        atMs: 0,
        createdAt: new Date().toISOString(),
        source: 'gemini-explicit',
      });
      await api().store.patch(receipt.visualId, { name: 'What I saw' });
      root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
      root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
      return { id: receipt.visualId, description: text };
    } finally {
      busy = false;
    }
  }
  function renderSDRows(list, files) {
    if (!list) return;
    list.replaceChildren();
    if (!files.length) {
      list.textContent = 'No unsynced Synap captures on the SD card.';
      return;
    }
    for (const file of files) {
      const row = document.createElement('div'),
        label = document.createElement('span'),
        action = document.createElement('button'),
        name = basename(file.path),
        type = file.path.endsWith('.wav') ? 'Audio on SD' : file.path.endsWith('.mjpeg') ? 'Video on SD' : 'Photo on SD';
      row.className = 'visual-sd-row';
      label.textContent = type + ' · ' + name + ' · ' + Math.max(1, Math.round((file.bytes || 0) / 1024)) + ' KB';
      action.type = 'button';
      action.textContent = 'Sync to Memories';
      action.addEventListener('click', async () => {
        action.disabled = true;
        try {
          await moveSD(file.path, (fraction) => status('Moving from SD · ' + Math.round(fraction * 100) + '%'));
          await api().syncPendingSD().catch(() => {});
          status(type.replace(' on SD', '') + ' synced to Memories. Verified SD source removed.');
          await browseSD(list.id);
        } catch (error) {
          status(error.message);
        } finally {
          action.disabled = false;
          renderSDInbox();
        }
      });
      row.append(label, action);
      list.append(row);
    }
  }
  async function browseSD(listId = 'visualSDList') {
    const list = document.getElementById(listId);
    if (!list) return [];
    list.hidden = false;
    list.replaceChildren();
    list.textContent = 'Checking Chakshu SD…';
    const files = await api().catalogue();
    renderSDRows(list, files);
    renderSDInbox();
    return files;
  }
  function renderSDInbox() {
    const state = api()?.state || {},
      panel = document.getElementById('librarySDInbox'),
      text = document.getElementById('librarySDInboxText'),
      check = document.getElementById('libraryCheckSD'),
      browse = document.getElementById('libraryBrowseSD'),
      sync = document.getElementById('librarySyncSD'),
      list = document.getElementById('librarySDList'),
      count = state.sdPendingCount ?? state.sdFiles?.length ?? 0;
    if (!panel) return;
    panel.hidden = !state.available;
    if (panel.hidden) return;
    if (text) {
      if (!state.connected)
        text.textContent = 'Connect Chakshu to check or sync its SD card. Offline captures remain safely on the card.';
      else if (!state.storageReady)
        text.textContent = 'Chakshu connected · SD card unavailable. Choose Check SD after inserting or reseating the card.';
      else
        text.textContent = count
          ? count + ' offline capture' + (count === 1 ? '' : 's') + ' waiting. Sync copies each item to Memories, verifies it, then removes the SD original.'
          : 'SD card ready · no unsynced offline captures.';
    }
    const blocked = busy || state.working || state.offline || Boolean(state.session);
    if (check) check.disabled = blocked || !state.connected || !state.mediaSupported;
    if (browse) browse.disabled = blocked || !state.connected || !state.storageReady;
    if (sync) sync.disabled = blocked || !state.connected || !state.storageReady || count === 0;
    if (list && (!state.connected || !state.storageReady)) list.hidden = true;
    else if (list && !list.hidden) renderSDRows(list, state.sdFiles || []);
  }
  async function syncAll() {
    if (busy) throw Error('Another Chakshu transfer is already running.');
    let pending = api()?.state?.sdFiles?.slice?.() || [];
    if (!pending.length) {
      await api().syncPendingSD();
      pending = api()?.state?.sdFiles?.slice?.() || [];
    }
    if (!pending.length) return { synced: 0, failed: 0 };
    let synced = 0, failed = 0, lastError = '';
    for (const file of pending) {
      try {
        await moveSD(file.path, (fraction) =>
          status('Syncing offline captures · ' + (synced + failed + 1) + '/' + pending.length + ' · ' + Math.round(fraction * 100) + '%'),
        );
        synced++;
      } catch (error) {
        failed++;
        lastError = error.message;
      }
    }
    await api().syncPendingSD().catch(() => {});
    if (failed)
      throw Error(synced + ' synced; ' + failed + ' kept on SD because verification failed. ' + lastError);
    return { synced, failed: 0 };
  }
  function upgradeUi() {
    const length = document.getElementById('visualSDLength');
    if (length && length.tagName === 'SELECT') {
      const input = document.createElement('input');
      input.id = 'visualSDLength';
      input.type = 'number';
      input.min = '1';
      input.max = '600';
      input.step = '1';
      input.value = '10';
      input.setAttribute('aria-label', 'SD video length in seconds');
      length.replaceWith(input);
    }
    const quality = document.getElementById('visualSDQuality');
    if (quality?.options?.length >= 2) {
      quality.options[0].textContent = 'Maximum detail';
      quality.options[1].textContent = 'HD motion';
    }
    const record = document.getElementById('visualRecordSD');
    if (record) record.disabled = true;
    const browse = document.getElementById('visualSD');
    browse?.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        browseSD().catch((error) => status(error.message));
      },
      true,
    );
    const sync = document.getElementById('visualSyncSD');
    sync?.addEventListener('click', async () => {
      sync.disabled = true;
      try {
        const result = await syncAll();
        status(result.synced ? result.synced + ' offline capture' + (result.synced === 1 ? '' : 's') + ' synced.' : 'No offline captures waiting.');
      } catch (error) {
        status(error.message);
      } finally {
        sync.disabled = false;
        renderSDInbox();
      }
    });
    const libraryCheck = document.getElementById('libraryCheckSD');
    libraryCheck?.addEventListener('click', async () => {
      libraryCheck.disabled = true;
      try {
        status('Checking Chakshu SD…');
        await api().refreshSD();
        await api().syncPendingSD().catch(() => {});
      } catch (error) {
        status(error.message);
      } finally {
        libraryCheck.disabled = false;
        renderSDInbox();
      }
    });
    const libraryBrowse = document.getElementById('libraryBrowseSD');
    libraryBrowse?.addEventListener('click', async () => {
      libraryBrowse.disabled = true;
      try {
        await browseSD('librarySDList');
      } catch (error) {
        status(error.message);
      } finally {
        libraryBrowse.disabled = false;
        renderSDInbox();
      }
    });
    const librarySync = document.getElementById('librarySyncSD');
    librarySync?.addEventListener('click', async () => {
      librarySync.disabled = true;
      try {
        const result = await syncAll();
        status(
          result.synced
            ? result.synced + ' offline capture' + (result.synced === 1 ? '' : 's') + ' moved to Memories; verified SD originals removed.'
            : 'No offline captures waiting.',
        );
        await browseSD('librarySDList');
      } catch (error) {
        status(error.message);
      } finally {
        librarySync.disabled = false;
        renderSDInbox();
      }
    });
    if (browse?.parentNode && !document.getElementById('visualClearSD')) {
      const clear = document.createElement('button');
      clear.id = 'visualClearSD';
      clear.type = 'button';
      clear.textContent = 'Clear SD';
      clear.addEventListener('click', async () => {
        if (!confirm('Remove all Synap captures from the Chakshu SD card? Other files and voice-model files are kept.')) return;
        clear.disabled = true;
        try {
          const count = await clearSD();
          status('Cleared ' + count + ' Synap capture' + (count === 1 ? '' : 's') + ' from SD.');
          await browseSD();
        } catch (error) {
          status(error.message);
        } finally {
          clear.disabled = false;
        }
      });
      browse.parentNode.insertBefore(clear, browse.nextSibling);
    }
  }
  const exposed = { moveSD, syncAll, clearSD, startOffline, startOfflineAudio, describeNow, browseSD, renderSDInbox, get busy() { return busy; } };
  root.SynapChakshuV2 = exposed;
  for (const name of ['synap-chakshu-changed', 'synap-module-changed', 'synap-chakshu-sd-pending', 'synap-gatt-disconnected'])
    root.addEventListener?.(name, renderSDInbox);
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => { upgradeUi(); renderSDInbox(); }, { once: true });
  else { upgradeUi(); renderSDInbox(); }
})(globalThis);