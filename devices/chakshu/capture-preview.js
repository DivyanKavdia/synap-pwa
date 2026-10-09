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
  const WIFI_UPLOAD_PREFIX = 'synap-c3-wifi-upload-v1:';
  const pause = (ms) => new Promise((resolve) => root.setTimeout(resolve, ms));
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
    if (!state?.available) throw Error('Sign in and connect a media-capable pendant first.');
    if (!state.connected || !connection?.deviceId)
      throw Error(state?.connectionStatus?.message || 'Connect the pendant first.');
    if (!state.mediaSupported) throw Error('Update pendant firmware for SD media controls.');
    return connection;
  }
  function client() {
    return new root.SynapChakshuTransfer.Client(context());
  }
  function pathOk(path) {
    return /^\/synap\/(?:[a-f0-9]{8}-[a-f0-9]{8}\.(?:jpg|wav|mjpeg|json)|[a-z0-9][a-z0-9._-]{0,51}\.wav)$/i.test(
      path,
    );
  }
  async function digest(blob) {
    const bytes = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function crc32(bytes, start = 0) {
    let crc = 0xffffffff;
    for (let i = start; i < bytes.length; i++) {
      crc = (crc ^ bytes[i]) >>> 0;
      for (let bit = 0; bit < 8; bit++)
        crc = ((crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)) >>> 0;
    }
    return (~crc) >>> 0;
  }
  async function verifyFirmwareCrc(blob, entry) {
    const expected = Number(entry?.crc32);
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > 0xffffffff) return null;
    if (!String(entry?.path || '').toLowerCase().endsWith('.wav')) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 44) throw Error('SD recording is shorter than a WAV header. The SD original was kept.');
    const actual = crc32(bytes, 44);
    if (actual !== expected)
      throw Error('SD recording integrity check failed before import. The SD original was kept.');
    return actual;
  }
  const basename = (path) => path.split('/').pop();
  const stem = (path) => path.replace(/\.[^.]+$/, '');
  const receiptKey = (deviceId, path) => RECEIPT_PREFIX + deviceId + ':' + path;
  function storedReceipt(path) {
    const connection = root.SynapDevices?.connection,
      owner = api()?.state?.owner;
    if (!connection?.deviceId || !owner) return null;
    try {
      const receipt = JSON.parse(localStorage.getItem(receiptKey(connection.deviceId, path)) || 'null');
      return receipt && receipt.owner === owner && receipt.deviceId === connection.deviceId && receipt.path === path
        ? receipt
        : null;
    } catch (_) {
      return null;
    }
  }
  const isSDSynced = (path) => Boolean(storedReceipt(path));
  const wifiUploadKey = (owner, deviceId, path) =>
    WIFI_UPLOAD_PREFIX + owner + ':' + deviceId + ':' + path;
  function c3WifiSupported() {
    const info = root.SynapModules?.client?.module;
    return Boolean(info?.id === 2 && (info.mediaFeatures & 2));
  }
  function c3FormatSupported() {
    const info = root.SynapModules?.client?.module;
    return Boolean(info?.id === 2 && (info.mediaFeatures & 4));
  }
  function audioJournal() {
    return new root.DKAudioStore({ ...root.SynapRecordingJournal.options() });
  }
  async function responseJson(response, fallback) {
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw Error(data?.error?.message || fallback || ('HTTP ' + response.status));
    return data || {};
  }
  async function c3WifiStatus() {
    if (!c3WifiSupported()) return null;
    return client().c3WifiStatus();
  }
  async function configureC3Wifi(ssid, password) {
    if (!c3WifiSupported()) throw Error('Update Odyssey C3 firmware for direct Wi-Fi sync.');
    return client().configureC3Wifi(ssid, password);
  }
  async function forgetC3Wifi() {
    if (!c3WifiSupported()) return null;
    return client().forgetC3Wifi();
  }
  async function beginC3CloudUpload(path, sourceEntry, connection, owner) {
    if (!root.SynapAuth?.isSignedIn?.()) throw Error('Sign in with Google before using Wi-Fi sync.');
    const bytes = Math.max(0, Number(sourceEntry?.bytes) || 0);
    if (bytes <= 44) throw Error('This SD recording contains no audio to sync.');
    const durationMs = Math.max(1, Math.floor((bytes - 44) / 32));
    const key = wifiUploadKey(owner, connection.deviceId, path);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
    const validId = /^[0-9a-f-]{36}$/i.test(String(saved?.recordingId || ''));
    const recordingId = validId ? saved.recordingId : crypto.randomUUID();
    const firstSeen = Date.parse(sourceEntry?.seenAt || '');
    const endedAtMs = Number.isFinite(firstSeen) ? firstSeen : Date.now();
    const startedAt = new Date(Math.max(0, endedAtMs - durationMs)).toISOString();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const response = await root.SynapAuth.authedFetch('/v1/device-uploads', {
      method: 'POST',
      expectedUid: owner,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recording_id: recordingId,
        device_id: connection.deviceId,
        started_at: startedAt,
        language: 'auto',
        timezone,
      }),
    });
    const ticket = await responseJson(response, 'Synap Cloud could not prepare Wi-Fi sync.');
    if (!ticket.upload_token || ticket.recording_id !== recordingId)
      throw Error('Synap Cloud returned an invalid Wi-Fi upload ticket.');
    localStorage.setItem(key, JSON.stringify({ recordingId, createdAt: new Date().toISOString() }));
    return {
      key,
      recordingId,
      endpoint: root.SynapAuth.config().backendUrl,
      token: ticket.upload_token,
      durationMs,
    };
  }
  async function moveC3Wifi(path, sourceEntry, progress = () => {}) {
    if (busy) throw Error('Another SD transfer is already running.');
    const connection = context(), owner = api().state.owner;
    busy = true;
    renderSDInbox();
    reportSDStage(path, 'wifi-ticket');
    try {
      const ticket = await beginC3CloudUpload(path, sourceEntry, connection, owner);
      if (owner !== api().state.owner || connection !== root.SynapDevices?.connection)
        throw Error('Account or pendant changed before Wi-Fi sync started.');
      reportSDStage(path, 'wifi-start', { recordingId: ticket.recordingId });
      const transfer = client();
      let state = await transfer.startC3WifiUpload({
        endpoint: ticket.endpoint,
        token: ticket.token,
        recordingId: ticket.recordingId,
        path,
      });
      for (;;) {
        const total = Math.max(0, Number(state?.total) || Number(sourceEntry?.bytes) || 0);
        const uploaded = Math.max(0, Number(state?.uploaded) || 0);
        if (total > 44) progress(Math.min(1, uploaded / Math.max(1, total - 44)));
        status(
          state?.message ||
          (state?.active
            ? 'Syncing over Wi-Fi · ' + Math.round(Math.min(1, uploaded / Math.max(1, total - 44)) * 100) + '%'
            : 'Checking Wi-Fi sync…'),
        );
        if (Number(state?.phase) === 6) {
          throw Error(
            String(state?.message || 'Wi-Fi sync failed.') +
              (state?.http ? ' HTTP ' + state.http + '.' : ''),
          );
        }
        if (!state?.active) {
          if (Number(state?.phase) === 5) break;
          throw Error(state?.message || 'Wi-Fi sync stopped before cloud verification.');
        }
        await pause(750);
        if (owner !== api().state.owner || connection !== root.SynapDevices?.connection)
          throw Error('Wi-Fi sync is continuing on the pendant. Reconnect to refresh Memories.');
        state = await transfer.c3WifiStatus();
      }
      progress(1);
      localStorage.removeItem(ticket.key);
      const receipt = {
        schema: 1,
        owner,
        deviceId: connection.deviceId,
        path,
        audioId: ticket.recordingId,
        visualId: null,
        mainBytes: Math.max(0, Number(sourceEntry?.bytes) || 0),
        ...(sourceEntry?.crc32 !== undefined ? { sourceCrc32: sourceEntry.crc32 } : {}),
        ...(sourceEntry?.take ? { take: sourceEntry.take, part: sourceEntry.part ?? null } : {}),
        wifi: true,
        cloud: true,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(receiptKey(connection.deviceId, path), JSON.stringify(receipt));
      reportSDStage(path, 'wifi-verified', { recordingId: ticket.recordingId });
      await root.SynapCloudHistory?.restore?.(true, { limit: 100 }).catch?.(() => {});
      root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
      return { ...receipt, alreadySynced: false, keptOnSD: true };
    } catch (error) {
      reportSDStage(path, 'wifi-failed', { message: error?.message || String(error) });
      throw error;
    } finally {
      busy = false;
      renderSDInbox();
    }
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
    let verifiedAudio = null;
    if (expectedWav) {
      if (!row.audioId) throw Error('The video soundtrack was not saved. The SD original was kept.');
      verifiedAudio = await verifyAudio(row.audioId, expectedWav);
    }
    return { ...row, verifiedAudio };
  }
  // The journal stores 50ms / 1600-byte PCM frames. ImportAudio pads only
  // the final incomplete frame with zeroes, then regenerates the WAV lengths.
  // Verify the ENTIRE journal WAV against that deterministic transformation,
  // rather than incorrectly comparing its size to the shorter SD original.
  async function normalizedImportedWav(source) {
    if (!(source instanceof Blob) || source.size < 44)
      throw Error('Invalid imported WAV source. The SD original was kept.');
    const header = new Uint8Array(await source.slice(0, 44).arrayBuffer()),
      view = new DataView(header.buffer),
      tag = (at, text) => [...text].every((char, i) => header[at + i] === char.charCodeAt(0)),
      pcmBytes = source.size - 44;
    if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data') ||
        view.getUint32(4, true) !== source.size - 8 ||
        view.getUint32(16, true) !== 16 ||
        view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
        view.getUint32(24, true) !== 16000 || view.getUint32(28, true) !== 32000 ||
        view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
        view.getUint32(40, true) !== pcmBytes || pcmBytes % 2 !== 0)
      throw Error('Invalid imported PCM WAV header. The SD original was kept.');
    const padding = (1600 - (pcmBytes % 1600)) % 1600;
    if (!padding) return source;
    view.setUint32(4, pcmBytes + padding + 36, true);
    view.setUint32(40, pcmBytes + padding, true);
    return new Blob([header, source.slice(44), new Uint8Array(padding)], { type: 'audio/wav' });
  }
  async function verifyAudio(id, expected) {
    const journal = audioJournal(),
      record = await journal.get('recordings', id);
    if (!record || !record.sealed) throw Error('The imported audio is still saving. The SD original was kept.');
    const saved = await journal.blob(record),
      normalized = await normalizedImportedWav(expected);
    const savedHash = saved.size === normalized.size ? await digest(saved) : null;
    if (!savedHash || savedHash !== (await digest(normalized)))
      throw Error('The saved audio did not match the SD source after frame alignment. The SD original was kept.');
    // Receipts must track the actual sealed journal WAV, not the shorter SD
    // bytes: otherwise every reconnect invalidates receipts and reimports.
    return { record, bytes: saved.size, sha256: savedHash };
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
  async function deleteSDItem(path) {
    if (busy) throw Error('Another SD transfer is already running.');
    const connection = context();
    if (api().state.offline || api().state.session || root.SynapAppControls?.recordingState?.().active)
      throw Error('Stop recording before deleting from the SD card.');
    busy = true;
    renderSDInbox();
    try {
      reportSDStage(path, 'delete-user-requested');
      await deleteSyncedSet(path);
      localStorage.removeItem(receiptKey(connection.deviceId, path));
      await api().catalogue().catch(() => {});
      root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
      return true;
    } finally {
      busy = false;
      renderSDInbox();
    }
  }

  async function discardIncompleteSD(path) {
    if (busy) throw Error('Another SD transfer is already running.');
    const entry = api()?.state?.sdFiles?.find?.((file) => file.path === path),
      bytes = Math.max(0, Number(entry?.bytes) || 0);
    if (!entry) throw Error('This SD file is no longer available.');
    if (entry.syncable !== false && bytes > 44)
      throw Error('This SD recording contains audio. Sync it to Memories instead of deleting it.');
    if (api().state.offline || api().state.session || root.SynapAppControls?.recordingState?.().active)
      throw Error('Stop recording before removing the incomplete SD file.');
    busy = true;
    try {
      reportSDStage(path, 'delete-incomplete-source', { bytes });
      await deleteSD(path);
    } finally {
      busy = false;
    }
    await api().catalogue().catch(() => {});
    root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
    return { path, bytes };
  }
  async function describeVisual(visualId, blob, source = 'gemini-offline-voice') {
    if (!visualId || !blob) throw Error('The photo is unavailable for visual inference.');
    const owner = api().state.owner;
    const response = await root.SynapAuth.authedFetch('/v1/chakshu/describe', {
      method: 'POST',
      expectedUid: owner,
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error?.message || 'The photo could not be described.');
    const text = String(data.description || '').trim();
    if (!text) throw Error('The image service returned no description.');
    await api().store.addDescription(visualId, {
      text: text.slice(0, 2000),
      atMs: 0,
      createdAt: new Date().toISOString(),
      source,
    });
    await api().store.patch(visualId, { name: 'What I saw' });
    root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
    root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
    return text;
  }
  async function describeSavedVisual(visualId) {
    const row = await api().store.get(visualId);
    if (!row || row.kind !== 'image' || row.state !== 'saved')
      throw Error('The synced photo is unavailable for visual inference.');
    const frames = await api().store.frames(visualId),
      blob = new Blob(frames.map((frame) => frame.blob), { type: 'image/jpeg' });
    if (!blob.size) throw Error('The synced photo has no image bytes.');
    return describeVisual(visualId, blob);
  }
    function reportSDStage(path, stage, detail = {}) {
    root.dispatchEvent?.(
      new CustomEvent('synap-sd-sync-diagnostic', {
        detail: { path, stage, ...detail },
      }),
    );
  }
  async function moveSD(path, progress = () => {}) {
    if (busy) throw Error('Another Chakshu transfer is already running.');
    const sourceEntry = api()?.state?.sdFiles?.find?.((file) => file.path === path);
    // Old catalogue entries can remain visible after a brownout. Avoid
    // repeatedly issuing doomed SD reads when current C3 status says mount
    // failed; keep the original on SD for explicit recovery/reselection.
    const liveModule = root.SynapModules?.client?.module;
    if (liveModule?.id === 2 && liveModule.sdDetectionState === 2) {
      reportSDStage(path, 'blocked-sd-unavailable', {
        sdLiveProbeState: liveModule.sdLiveProbeState,
      });
      throw Error('The C3 SD card is unavailable after a reset. Recover the card before syncing; the SD original was kept.');
    }
    if (sourceEntry && (sourceEntry.syncable === false || Number(sourceEntry.bytes) <= 44)) {
      const bytes = Math.max(0, Number(sourceEntry.bytes) || 0);
      reportSDStage(path, 'blocked-incomplete-source', { bytes });
      throw Error(
        bytes
          ? 'This SD recording did not finalize and cannot be synced. It has been kept on the SD card.'
          : 'This SD recording contains no audio bytes and cannot be synced. It has been kept on the SD card.',
      );
    }
    const connection = context(),
      owner = api().state.owner,
      wantsDescribe = Boolean(api().state.sdFiles?.find((file) => file.path === path)?.describe),
      key = receiptKey(connection.deviceId, path);
    let stage = 'receipt-check';
    busy = true;
    renderSDInbox();
    reportSDStage(path, stage);
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (await verifyReceipt(cached)) {
        reportSDStage(path, 'already-synced', { audioId: cached.audioId || null, visualId: cached.visualId || null });
        if (wantsDescribe && cached.visualId && !cached.description) {
          try {
            cached.description = await describeSavedVisual(cached.visualId);
          } catch (error) {
            cached.descriptionError = error.message;
          }
        }
        return { ...cached, alreadySynced: true, keptOnSD: true };
      }
      localStorage.removeItem(key);
      stage = 'download';
      reportSDStage(path, stage);
      const before = await localSnapshot(),
        source = await download(path, undefined, progress);
      reportSDStage(path, 'download-complete', { bytes: source.main.size });
      if (sourceEntry?.crc32 !== undefined && path.endsWith('.wav')) {
        stage = 'integrity';
        reportSDStage(path, stage, { expectedCrc32: sourceEntry.crc32 });
        const verifiedCrc32 = await verifyFirmwareCrc(source.main, sourceEntry);
        reportSDStage(path, 'integrity-complete', { crc32: verifiedCrc32 });
      }
      const mainSha = await digest(source.main);
      if (owner !== api().state.owner || connection !== root.SynapDevices?.connection)
        throw Error('Account or pendant changed during transfer. The SD original was kept.');
      stage = 'import';
      reportSDStage(path, stage, { files: source.files.length });
      await api().importFiles(source.files, connection.deviceId);
      reportSDStage(path, 'import-complete');
      const rows = await api().store.list(),
        journal = audioJournal(),
        recordings = await journal.all('recordings');
      let visualId = null,
        audioId = null,
        verifiedAudio = null;
      stage = 'verify';
      reportSDStage(path, stage);
      if (/\.(jpg|mjpeg)$/.test(path)) {
        const row = rows
          .filter((item) => !before.visuals.has(item.id) && item.sourceName === basename(path))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        if (!row) throw Error('The imported visual could not be verified. The SD original was kept.');
        const verifiedVisual = await verifyVisual(row.id, source.main, source.wav);
        verifiedAudio = verifiedVisual.verifiedAudio;
        visualId = row.id;
        audioId = row.audioId || null;
      } else if (path.endsWith('.wav')) {
        const record = recordings
          .filter((item) => !before.recordings.has(item.id) && item.ownerUid === owner)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        if (!record) throw Error('The imported audio could not be verified. The SD original was kept.');
        verifiedAudio = await verifyAudio(record.id, source.main);
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
        ...(sourceEntry?.crc32 !== undefined ? { sourceCrc32: sourceEntry.crc32 } : {}),
        ...(sourceEntry?.take ? { take: sourceEntry.take, part: sourceEntry.part ?? null } : {}),
        mainSha256: mainSha,
        ...(verifiedAudio
          ? { audioBytes: verifiedAudio.bytes, audioSha256: verifiedAudio.sha256 }
          : {}),
        describeRequested: wantsDescribe,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(key, JSON.stringify(receipt));
      reportSDStage(path, 'verify-complete', { audioId, visualId });
      reportSDStage(path, 'complete', { audioId, visualId, keptOnSD: true });
      root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
      // Verification completes the sync transaction. The SD original is kept
      // until the user explicitly chooses Delete from SD. Cloud inference is
      // independent of that retention choice; Memories stays durable either way.
      if (wantsDescribe && visualId) {
        try {
          receipt.description = await describeVisual(visualId, source.main);
        } catch (error) {
          receipt.descriptionError = error.message;
        }
      }
      return { ...receipt, alreadySynced: false, keptOnSD: true };
    } catch (error) {
      reportSDStage(path, 'failed', { failedAt: stage, message: error?.message || String(error) });
      throw error;
    } finally {
      busy = false;
      renderSDInbox();
    }
  }
  async function clearSD() {
    if (busy) throw Error('Another SD transfer is already running.');
    const connection = context();
    if (api().state.offline || api().state.session || root.SynapAppControls.recordingState().active)
      throw Error('Stop recording before clearing the SD card.');
    busy = true;
    try {
      const reply = await client().request(18);
      // C3 firmware currently deletes at most 100 files per clear. Never
      // discard every verified local receipt: undeleted SD originals must
      // remain marked as synced and must not be imported twice on reconnect.
      // Old receipts for deleted unique paths are harmless and can be removed
      // individually through Delete from SD. Refresh observationally; do not
      // force an unnecessary SD unmount/remount (media op 14) after clearing.
      try {
        await api().catalogue();
      } catch (error) {
        reportSDStage('@all', 'clear-catalogue-unavailable', {
          removed: reply.total || 0,
          message: error?.message || String(error),
        });
      }
      return reply.total || 0;
    } finally {
      busy = false;
    }
  }
  async function formatSD() {
    if (busy) throw Error('Another SD transfer is already running.');
    const connection = context();
    if (!c3FormatSupported()) throw Error('Update Odyssey C3 firmware to format its SD card.');
    if (api().state.offline || api().state.session || root.SynapAppControls.recordingState().active)
      throw Error('Stop recording before formatting the SD card.');
    busy = true;
    renderSDInbox();
    try {
      status('Formatting SD card…');
      await client().request(19);
      await api().refreshSD();
      const info = root.SynapModules?.client?.module;
      if (info?.sdDetectionState !== 1 || info?.sdProbeState !== 6)
        throw Error('Format completed but the SD card did not return ready. Reconnect and check storage.');
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key?.startsWith(RECEIPT_PREFIX + connection.deviceId + ':')) localStorage.removeItem(key);
      }
      status('SD card formatted · FAT storage is ready.');
      await api().syncPendingSD().catch(() => {});
      return true;
    } finally {
      busy = false;
      renderSDInbox();
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
      const text = await describeVisual(receipt.visualId, saved.blob, 'gemini-explicit');
      return { id: receipt.visualId, description: text };
    } finally {
      busy = false;
    }
  }
  function renderSDRows(list, files) {
    if (!list) return;
    list.replaceChildren();
    if (!files.length) {
      list.textContent = 'No Synap captures on the SD card.';
      return;
    }
    for (const file of files) {
      const row = document.createElement('div'),
        label = document.createElement('span'),
        action = document.createElement('button'),
        wifi = document.createElement('button'),
        remove = document.createElement('button'),
        name = basename(file.path),
        type = file.describe
          ? 'Explain photo on SD'
          : file.path.endsWith('.wav')
            ? 'Audio on SD'
            : file.path.endsWith('.mjpeg')
              ? 'Video on SD'
              : 'Photo on SD',
        incomplete = file.syncable === false || Number(file.bytes) <= 44,
        synced = !incomplete && isSDSynced(file.path),
        wifiEligible = !incomplete && !synced && file.path.endsWith('.wav') && c3WifiSupported();
      row.className = 'visual-sd-row';
      label.textContent =
        type + ' · ' + name + ' · ' + Math.max(1, Math.round((file.bytes || 0) / 1024)) + ' KB' +
        (synced ? ' · Synced to Memories' : incomplete ? ' · Incomplete' : ' · Not synced');
      action.type = 'button';
      action.textContent = incomplete ? 'Cannot sync' : synced ? 'Synced to Memories' : 'Sync to Memories';
      action.disabled = incomplete || synced;
      if (!action.disabled) {
        action.addEventListener('click', async () => {
          action.disabled = true;
          wifi.disabled = true;
          try {
            await moveSD(file.path, (fraction) =>
              status('Syncing to Memories over Bluetooth · ' + Math.round(fraction * 100) + '%'),
            );
            const deleteNow = confirm(
              'Synced to Memories successfully. Delete this recording from the device SD card now? The copy in Memories will be kept.',
            );
            if (deleteNow) {
              await deleteSDItem(file.path);
              status(type.replace(' on SD', '') + ' synced to Memories · SD copy deleted.');
            } else {
              status(type.replace(' on SD', '') + ' synced to Memories · SD copy kept.');
            }
          } catch (error) {
            status(error.message);
          } finally {
            action.disabled = false;
            wifi.disabled = false;
            await browseSD(list.id).catch(() => {});
            renderSDInbox();
          }
        });
      }
      wifi.type = 'button';
      wifi.textContent = 'Transfer over Wi-Fi';
      wifi.hidden = !wifiEligible;
      wifi.disabled = !wifiEligible;
      if (wifiEligible) {
        wifi.addEventListener('click', async () => {
          action.disabled = true;
          wifi.disabled = true;
          try {
            const network = await c3WifiStatus().catch(() => null);
            if (!network?.configured)
              throw Error('Save a 2.4 GHz Wi-Fi or phone hotspot in Settings → Wi-Fi sync first.');
            await moveC3Wifi(file.path, file, (fraction) =>
              status('Transferring over Wi-Fi · ' + Math.round(fraction * 100) + '%'),
            );
            const deleteNow = confirm(
              'Wi-Fi transfer completed and the recording is safely stored in Synap Cloud. Delete this recording from the device SD card now?',
            );
            if (deleteNow) {
              await deleteSDItem(file.path);
              status('Wi-Fi transfer complete · SD copy deleted.');
            } else {
              status('Wi-Fi transfer complete · SD copy kept.');
            }
          } catch (error) {
            status(error.message);
          } finally {
            action.disabled = false;
            wifi.disabled = false;
            await browseSD(list.id).catch(() => {});
            renderSDInbox();
          }
        });
      }
      remove.type = 'button';
      remove.textContent = 'Delete from SD';
      remove.addEventListener('click', async () => {
        const warning = synced
          ? 'Delete this SD copy? The synced copy in Memories will be kept.'
          : incomplete
            ? 'Delete this incomplete recording from the SD card? This cannot be undone.'
            : 'Delete this recording from the SD card without syncing it to Memories? This cannot be undone.';
        if (!confirm(warning)) return;
        remove.disabled = true;
        try {
          await deleteSDItem(file.path);
          status(synced ? 'SD copy deleted. Memory kept.' : 'Recording deleted from SD.');
          await browseSD(list.id);
        } catch (error) {
          status(error.message);
        } finally {
          remove.disabled = false;
          renderSDInbox();
        }
      });
      row.append(label, action, wifi, remove);
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
      toggle = document.getElementById('libraryStorageInfoToggle'),
      text = document.getElementById('librarySDInboxText'),
      check = document.getElementById('libraryCheckSD'),
      browse = document.getElementById('libraryBrowseSD'),
      sync = document.getElementById('librarySyncSD'),
      list = document.getElementById('librarySDList'),
      sdFiles = state.sdFiles || [],
      count = sdFiles.length,
      unsyncedCount = sdFiles.filter(
        (file) => file.syncable !== false && Number(file.bytes) > 44 && !isSDSynced(file.path),
      ).length,
      deviceId = root.SynapDevices?.connection?.deviceId || state.sdFilesDeviceId || state.devices?.[0]?.deviceId || '',
      last = root.SynapChakshuVoice?.lastOutcome?.(deviceId),
      outcome = last?.message ? String(last.message).replace(/Chakshu SD/g, 'device storage').replace(/Chakshu/g, 'device') : '',
      suffix = outcome ? ' Last offline result: ' + outcome : '',
      blocked = busy || state.working || state.offline || Boolean(state.session),
      settings = document.getElementById('deviceSDSettings'),
      settingsStatus = document.getElementById('deviceSDSettingsStatus'),
      retrySettings = document.getElementById('retryDeviceSD'),
      clearSettings = document.getElementById('clearDeviceSD'),
      formatSettings = document.getElementById('formatDeviceSD'),
      wifiSettings = document.getElementById('deviceWifiSettings'),
      wifiSettingsStatus = document.getElementById('deviceWifiSettingsStatus'),
      wifiSave = document.getElementById('saveDeviceWifi'),
      wifiForget = document.getElementById('forgetDeviceWifi'),
      info = root.SynapModules?.client?.module,
      supportsC3Wifi = Boolean(info?.id === 2 && (info?.mediaFeatures & 2)),
      supportsC3Format = Boolean(info?.id === 2 && (info?.mediaFeatures & 4)),
      supportsStorage =
        Boolean(info) &&
        root.SynapCapabilities?.hasMedia?.(info) &&
        root.SynapCapabilities?.supports?.(info, 'sd');
    if (settings) settings.hidden = !supportsStorage;
    if (settingsStatus && supportsStorage)
      settingsStatus.textContent = !state.connected
        ? 'Connect the pendant to manage its SD card.'
        : busy
          ? 'SD transfer in progress · SD maintenance controls are temporarily disabled.'
          : state.storageReady
            ? count
              ? count + ' item' + (count === 1 ? '' : 's') + ' on SD · ' + unsyncedCount + ' waiting to sync.'
              : 'SD card ready · no captures on SD.'
            : info?.id === 2 && info?.sdProbeState === 1
            ? 'SD SPI bus setup failed.'
            : info?.id === 2 && info?.sdProbeState === 2
              ? 'SD card protocol initialization failed.'
              : info?.id === 2 && info?.sdProbeState === 3
                ? 'SD card initialized, but the FAT filesystem could not be mounted.'
                : info?.id === 2 && info?.sdProbeState === 4
                  ? 'SD filesystem mounted, but VFS validation failed.'
                  : 'SD card unavailable. Check the card and retry storage.';
    if (retrySettings)
      retrySettings.disabled =
        !supportsStorage ||
        blocked ||
        !state.connected ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
    if (clearSettings)
      clearSettings.disabled =
        !supportsStorage ||
        blocked ||
        !state.connected ||
        !state.storageReady ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
    if (formatSettings) {
      formatSettings.hidden = !supportsC3Format;
      formatSettings.disabled =
        !supportsC3Format ||
        blocked ||
        !state.connected ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
    }
    if (wifiSettings) wifiSettings.hidden = !supportsC3Wifi;
    if (wifiSave)
      wifiSave.disabled =
        !supportsC3Wifi ||
        blocked ||
        !state.connected ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
    if (wifiForget)
      wifiForget.disabled =
        !supportsC3Wifi ||
        blocked ||
        !state.connected ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
    if (wifiSettingsStatus && supportsC3Wifi && !state.connected)
      wifiSettingsStatus.textContent = 'Connect Odyssey C3 to manage its saved Wi-Fi network.';
    if (!panel) return;
    if (toggle) {
      toggle.hidden = !state.available;
      if (!state.available) toggle.setAttribute('aria-expanded', 'false');
    }
    const open = Boolean(toggle && toggle.getAttribute('aria-expanded') === 'true');
    panel.hidden = !state.available || !open;
    if (panel.hidden) return;
    if (text) {
      if (!state.connected)
        text.textContent = 'Connect a device to review or sync content saved offline. Photos, videos and audio remain safely stored locally until sync.' + suffix;
      else if (!state.storageReady)
        text.textContent = 'Device connected · local storage unavailable. Check the device storage and try again.' + suffix;
      else
        text.textContent = (count
          ? count + ' item' + (count === 1 ? '' : 's') + ' on SD · ' + unsyncedCount + ' waiting to sync. Synced SD copies stay visible until you choose Delete from SD.'
          : 'Device storage ready · no captures on SD.') + suffix;
    }
    if (check) check.disabled = blocked || !state.connected || !state.mediaSupported;
    if (browse) browse.disabled = blocked || !state.connected || !state.storageReady;
    if (sync) sync.disabled = blocked || !state.connected || !state.storageReady || unsyncedCount === 0;
    if (list && (!state.connected || !state.storageReady)) list.hidden = true;
    else if (list && !list.hidden) renderSDRows(list, state.sdFiles || []);
  }
  async function syncAll() {
    if (busy) throw Error('Another Chakshu transfer is already running.');
    let files = api()?.state?.sdFiles?.slice?.() || [];
    if (!files.length) {
      await api().catalogue();
      files = api()?.state?.sdFiles?.slice?.() || [];
    }
    const pending = files.filter(
      (file) => file.syncable !== false && Number(file.bytes) > 44 && !isSDSynced(file.path),
    );
    if (!pending.length) return { synced: 0, failed: 0, paths: [] };
    let synced = 0, failed = 0, lastError = '';
    const paths = [];
    for (const file of pending) {
      try {
        await moveSD(file.path, (fraction) =>
          status('Syncing offline captures · ' + (synced + failed + 1) + '/' + pending.length + ' · ' + Math.round(fraction * 100) + '%'),
        );
        synced++;
        paths.push(file.path);
      } catch (error) {
        failed++;
        lastError = error.message;
      }
    }
    await api().catalogue().catch(() => {});
    if (failed)
      throw Error(synced + ' synced; ' + failed + ' kept on SD because verification failed. ' + lastError);
    return { synced, failed: 0, paths };
  }
  async function offerDeleteSynced(paths) {
    const unique = [...new Set(paths || [])];
    if (!unique.length) return 0;
    const message = unique.length === 1
      ? 'Sync completed. Delete the synced recording from the device SD card now? The copy in Memories will be kept.'
      : 'Sync completed for ' + unique.length + ' recordings. Delete these synced copies from the device SD card now? The copies in Memories will be kept.';
    if (!confirm(message)) return 0;
    let deleted = 0;
    for (const path of unique) {
      await deleteSDItem(path);
      deleted++;
    }
    return deleted;
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
        const deleted = await offerDeleteSynced(result.paths);
        status(result.synced
          ? result.synced + ' offline capture' + (result.synced === 1 ? '' : 's') + ' synced to Memories' +
            (deleted ? ' · ' + deleted + ' SD cop' + (deleted === 1 ? 'y deleted.' : 'ies deleted.') : ' · SD cop' + (result.synced === 1 ? 'y kept.' : 'ies kept.'))
          : 'No unsynced offline captures waiting.');
      } catch (error) {
        status(error.message);
      } finally {
        sync.disabled = false;
        renderSDInbox();
      }
    });
    const libraryInfoToggle = document.getElementById('libraryStorageInfoToggle');
    libraryInfoToggle?.addEventListener('click', () => {
      const open = libraryInfoToggle.getAttribute('aria-expanded') === 'true';
      libraryInfoToggle.setAttribute('aria-expanded', String(!open));
      renderSDInbox();
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
        const deleted = await offerDeleteSynced(result.paths);
        status(
          result.synced
            ? result.synced + ' offline capture' + (result.synced === 1 ? '' : 's') + ' synced to Memories' +
              (deleted ? ' · ' + deleted + ' SD cop' + (deleted === 1 ? 'y deleted.' : 'ies deleted.') : ' · SD cop' + (result.synced === 1 ? 'y kept.' : 'ies kept.'))
            : 'No unsynced offline captures waiting.',
        );
        await browseSD('librarySDList');
      } catch (error) {
        status(error.message);
      } finally {
        librarySync.disabled = false;
        renderSDInbox();
      }
    });
    const extras = document.getElementById('settingsDeviceExtras');
    if (extras && !document.getElementById('deviceSDSettings')) {
      const card = document.createElement('section');
      card.id = 'deviceSDSettings';
      card.className = 'settings-card';
      card.hidden = true;
      card.innerHTML =
        '<h3 class="settings-card-title">SD card</h3>' +
        '<p id="deviceSDSettingsStatus" class="settings-hint">Connect a supported pendant to manage SD storage.</p>' +
        '<div class="visual-actions"><button id="retryDeviceSD" type="button">Retry SD card</button><button id="clearDeviceSD" type="button">Clear SD Card</button><button id="formatDeviceSD" type="button" hidden>Format SD Card</button></div>';
      extras.append(card);
      document.getElementById('retryDeviceSD')?.addEventListener('click', async () => {
        const button = document.getElementById('retryDeviceSD'),
          settingsStatus = document.getElementById('deviceSDSettingsStatus');
        button.disabled = true;
        if (settingsStatus) settingsStatus.textContent = 'Retrying SD card…';
        try {
          await api().refreshSD();
          const info = root.SynapModules?.client?.module;
          if (info?.sdDetectionState === 1 && info?.sdProbeState === 6) {
            if (settingsStatus) settingsStatus.textContent = 'SD card recovered · refreshing offline content…';
            await api().syncPendingSD().catch(() => {});
          } else if (settingsStatus) {
            settingsStatus.textContent =
              'SD retry finished · detection ' +
              String(info?.sdDetectionState ?? 'unknown') +
              ' / probe ' +
              String(info?.sdProbeState ?? 'unknown') +
              '.';
          }
        } catch (error) {
          if (settingsStatus) settingsStatus.textContent = 'SD retry failed · ' + error.message;
          status(error.message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
      document.getElementById('clearDeviceSD')?.addEventListener('click', async () => {
        if (
          !confirm(
            'Remove all Synap captures from this device SD card? Unrelated files are kept. This cannot be undone.',
          )
        )
          return;
        const button = document.getElementById('clearDeviceSD');
        button.disabled = true;
        try {
          const count = await clearSD();
          status(
            'Cleared ' +
              count +
              ' Synap capture' +
              (count === 1 ? '' : 's') +
              ' from the SD card.',
          );
          await api().syncPendingSD().catch(() => {});
        } catch (error) {
          status(error.message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
      document.getElementById('formatDeviceSD')?.addEventListener('click', async () => {
        if (
          !confirm(
            'Format this SD card? ALL files on the card will be permanently erased, including non-Synap files. This cannot be undone.',
          )
        )
          return;
        const button = document.getElementById('formatDeviceSD'),
          settingsStatus = document.getElementById('deviceSDSettingsStatus');
        button.disabled = true;
        if (settingsStatus) settingsStatus.textContent = 'Formatting SD card…';
        try {
          await formatSD();
          if (settingsStatus) settingsStatus.textContent = 'SD card formatted · ready for offline recording.';
        } catch (error) {
          if (settingsStatus) settingsStatus.textContent = 'SD format failed · ' + error.message;
          status(error.message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
    }
    if (extras && !document.getElementById('deviceWifiSettings')) {
      const card = document.createElement('section');
      card.id = 'deviceWifiSettings';
      card.className = 'settings-card';
      card.hidden = true;
      card.innerHTML =
        '<h3 class="settings-card-title">Wi-Fi sync</h3>' +
        '<p id="deviceWifiSettingsStatus" class="settings-hint">Save a 2.4 GHz Wi-Fi network once. Odyssey C3 will join it directly when syncing SD audio; your phone stays on its normal network.</p>' +
        '<label class="settings-field">Wi-Fi name (SSID)<input id="deviceWifiSsid" type="text" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false"></label>' +
        '<label class="settings-field">Wi-Fi password<input id="deviceWifiPassword" type="password" maxlength="63" autocomplete="new-password"></label>' +
        '<div class="visual-actions"><button id="saveDeviceWifi" type="button">Save Wi-Fi</button><button id="forgetDeviceWifi" type="button">Forget Wi-Fi</button></div>';
      extras.append(card);
      document.getElementById('saveDeviceWifi')?.addEventListener('click', async () => {
        const button = document.getElementById('saveDeviceWifi'),
          statusNode = document.getElementById('deviceWifiSettingsStatus'),
          ssid = document.getElementById('deviceWifiSsid')?.value || '',
          password = document.getElementById('deviceWifiPassword')?.value || '';
        button.disabled = true;
        if (statusNode) statusNode.textContent = 'Saving Wi-Fi to Odyssey C3…';
        try {
          const next = await configureC3Wifi(ssid, password);
          document.getElementById('deviceWifiPassword').value = '';
          card.dataset.configured = String(Boolean(next?.configured));
          if (statusNode)
            statusNode.textContent = next?.configured
              ? 'Wi-Fi saved on Odyssey C3. SD audio will prefer direct Wi-Fi sync.'
              : 'Wi-Fi was not saved. Check the network name and retry.';
        } catch (error) {
          if (statusNode) statusNode.textContent = 'Could not save Wi-Fi · ' + error.message;
          status(error.message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
      document.getElementById('forgetDeviceWifi')?.addEventListener('click', async () => {
        const button = document.getElementById('forgetDeviceWifi'),
          statusNode = document.getElementById('deviceWifiSettingsStatus');
        button.disabled = true;
        try {
          const next = await forgetC3Wifi();
          card.dataset.configured = String(Boolean(next?.configured));
          if (statusNode) statusNode.textContent = 'Saved Wi-Fi removed. SD sync will use Bluetooth.';
        } catch (error) {
          if (statusNode) statusNode.textContent = 'Could not forget Wi-Fi · ' + error.message;
          status(error.message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
      root.setTimeout(async () => {
        if (!c3WifiSupported() || !root.SynapDevices?.connection) return;
        const statusNode = document.getElementById('deviceWifiSettingsStatus');
        try {
          const next = await c3WifiStatus();
          card.dataset.configured = String(Boolean(next?.configured));
          if (statusNode)
            statusNode.textContent = next?.configured
              ? 'Wi-Fi is saved on Odyssey C3. SD audio will prefer direct Wi-Fi sync.'
              : 'No Wi-Fi network is saved. Add one to enable direct cloud sync.';
        } catch (_) {}
      }, 500);
    }
    if (browse?.parentNode && !document.getElementById('visualClearSD')) {
      const clear = document.createElement('button');
      clear.id = 'visualClearSD';
      clear.type = 'button';
      clear.textContent = 'Clear SD';
      clear.addEventListener('click', async () => {
        if (!confirm('Remove all Synap captures from this device SD card? Unrelated files are kept.')) return;
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
  const exposed = {
    moveSD,
    moveC3Wifi,
    c3WifiStatus,
    configureC3Wifi,
    forgetC3Wifi,
    discardIncompleteSD,
    deleteSDItem,
    isSDSynced,
    storedReceipt,
    syncAll,
    clearSD,
    formatSD,
    startOffline,
    startOfflineAudio,
    describeNow,
    browseSD,
    renderSDInbox,
    get busy() { return busy; },
  };
  root.SynapChakshuV2 = exposed;
  for (const name of ['synap-chakshu-changed', 'synap-module-changed', 'synap-chakshu-sd-pending', 'synap-gatt-disconnected'])
    root.addEventListener?.(name, renderSDInbox);
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => { upgradeUi(); renderSDInbox(); }, { once: true });
  else { upgradeUi(); renderSDInbox(); }
})(globalThis);