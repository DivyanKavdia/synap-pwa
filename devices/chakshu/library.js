/* Local photo/video library, playback, SD capture controls, notes and exports. */
(function (root) {
  'use strict';
  const $ = (id) => document.getElementById(id),
    api = () => root.SynapChakshu;
  let owner = '',
    generation = 0,
    viewerGeneration = 0,
    viewerUrls = [],
    player = null,
    selected = null,
    selectedFrames = [],
    frameIndex = 0,
    liveUrl = null,
    liveKey = '',
    renderSignature = '',
    access = '';
  const revoke = (list) => {
    for (const url of list) URL.revokeObjectURL(url);
    list.length = 0;
  };
  function status(message) {
    $('visualStatus').textContent = message || '';
  }
  function byteLabel(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function sdQuality(info) {
    if (!info?.width || !info?.height) return '';
    const fps =
      info.audioMs > 0
        ? ' · ' + ((info.frames * 1000) / info.audioMs).toFixed(1) + ' fps captured'
        : '';
    return (
      ' · ' +
      info.width +
      '×' +
      info.height +
      fps +
      (info.droppedFrames ? ' · ' + info.droppedFrames + ' dropped frames' : '')
    );
  }
  async function action(fn) {
    try {
      status('Working…');
      const result = await fn();
      status(typeof result === 'string' ? result : '');
    } catch (e) {
      status(e.message);
    }
  }
  function button(label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => action(fn));
    return b;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function closeViewer() {
    viewerGeneration++;
    player?.dispose();
    player = null;
    revoke(viewerUrls);
    selected = null;
    selectedFrames = [];
    $('visualDialog').close();
    $('visualPreview').removeAttribute('src');
    $('visualAudio').pause();
    $('visualAudio').removeAttribute('src');
    $('visualAudio').hidden = true;
    $('visualPlayback').hidden = true;
    $('visualSound').checked = true;
    $('visualSoundLabel').hidden = true;
    $('visualAudioSource').hidden = true;
    $('visualStage').classList.remove('zoomed');
    $('visualZoom').setAttribute('aria-pressed', 'false');
    $('visualZoom').textContent = 'Zoom view';
    $('visualName').value = '';
    $('visualNotes').value = '';
    $('visualTitle').textContent = 'Photo';
    $('visualInfo').textContent = '';
    $('visualTime').textContent = '';
    $('visualDetailStatus').textContent = '';
    $('visualAudioSource').removeAttribute('href');
    $('visualDescriptions').replaceChildren();
    $('visualAudioLink').replaceChildren();
    document.querySelector('.visual-edit').open = false;
    for (const id of ['visualSaveFrame', 'visualFavourite', 'visualSaveDetails', 'visualSaveLink'])
      $(id).disabled = false;
  }
  function pause() {
    player?.pause();
    $('visualPlay').textContent = 'Play video';
  }
  function viewContext() {
    const id = selected?.id,
      store = api().store,
      token = viewerGeneration;
    return {
      id,
      store,
      current: () => selected?.id === id && store === api().store && token === viewerGeneration,
    };
  }
  async function detailAction(buttonId, fn) {
    if (!selected) return;
    const context = viewContext(),
      control = $(buttonId);
    control.disabled = true;
    $('visualDetailStatus').textContent = 'Working…';
    try {
      const result = await fn(context);
      if (context.current()) $('visualDetailStatus').textContent = result || '';
    } catch (error) {
      if (context.current()) $('visualDetailStatus').textContent = error.message;
    } finally {
      if (context.current()) control.disabled = false;
    }
  }
  function renderFavourite() {
    $('visualFavourite').setAttribute('aria-pressed', String(Boolean(selected?.favourite)));
    $('visualFavourite').textContent = selected?.favourite
      ? 'Remove from favourites'
      : 'Add to favourites';
  }
  function renderDescriptions() {
    $('visualDescriptions').replaceChildren();
    for (const description of selected?.descriptions || []) {
      const article = document.createElement('article'),
        p = document.createElement('p');
      if (selected.kind === 'video') {
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.textContent = 'View at ' + (description.atMs / 1000).toFixed(1) + ' s';
        jump.addEventListener('click', () => {
          pause();
          let nearest = 0;
          for (let i = 1; i < selectedFrames.length; i++)
            if (
              Math.abs(selectedFrames[i].atMs - description.atMs) <
              Math.abs(selectedFrames[nearest].atMs - description.atMs)
            )
              nearest = i;
          showFrame(nearest);
        });
        article.append(jump);
      }
      p.textContent = description.text;
      article.append(p);
      $('visualDescriptions').append(article);
    }
  }
  function paintFrame(index) {
    frameIndex = Math.max(0, Math.min(index, selectedFrames.length - 1));
    if (!selectedFrames[frameIndex]) return;
    if ($('visualPreview').src !== viewerUrls[frameIndex])
      $('visualPreview').src = viewerUrls[frameIndex];
    $('visualPreviousFrame').disabled = frameIndex === 0;
    $('visualNextFrame').disabled = frameIndex === selectedFrames.length - 1;
  }
  function showFrame(index) {
    if (player)
      player.seek(
        selectedFrames[Math.max(0, Math.min(index, selectedFrames.length - 1))]?.atMs || 0,
      );
    else paintFrame(index);
  }
  function playbackChanged(state) {
    paintFrame(state.index);
    $('visualSeek').max = Math.round(state.durationMs);
    $('visualSeek').value = Math.round(state.timeMs);
    const label = root.SynapChakshuPlayer.timeLabel;
    $('visualTime').textContent = label(state.timeMs) + ' / ' + label(state.durationMs);
    $('visualSeek').setAttribute('aria-valuetext', $('visualTime').textContent);
    $('visualPlay').textContent = state.playing ? 'Pause video' : 'Play video';
    $('visualPlay').setAttribute('aria-pressed', String(state.playing));
    $('visualStage').dataset.playing = String(state.playing);
  }
  async function open(id) {
    closeViewer();
    const token = viewerGeneration;
    const store = api().store,
      expected = api().state.owner;
    const row = await store.get(id),
      frames = await store.frames(id);
    if (
      token !== viewerGeneration ||
      store !== api().store ||
      expected !== api().state.owner ||
      !row
    )
      return;
    selected = row;
    selectedFrames = frames;
    for (const frame of frames) viewerUrls.push(URL.createObjectURL(frame.blob));
    const video = row.kind === 'video';
    $('visualPlayback').hidden = !video;
    $('visualSpeed').value = '1';
    if (video)
      player = new root.SynapChakshuPlayer.Player({
        frames,
        durationMs: row.durationMs,
        change: playbackChanged,
      });
    $('visualTitle').textContent = row.name || (row.kind === 'image' ? 'Photo' : 'Video');
    $('visualSeek').hidden = row.kind !== 'video';
    $('visualPlay').hidden = row.kind !== 'video';
    $('visualPlay').textContent = 'Play video';
    for (const id of ['visualPreviousFrame', 'visualNextFrame', 'visualSaveFrame'])
      $(id).hidden = row.kind !== 'video';
    $('visualSaveFrame').disabled = !frames.length;
    $('visualDownload').disabled = !frames.length;
    $('visualDownload').textContent = row.previewOnly ? 'Download preview' : 'Download original';
    $('visualZoom').disabled = !frames.length;
    $('visualPlay').disabled = !frames.length;
    $('visualName').value = row.name || '';
    $('visualNotes').value = row.notes || '';
    renderFavourite();
    $('visualInfo').textContent =
      (row.state === 'interrupted' ? 'Interrupted capture · ' : '') +
      (video ? 'Video playback · linked audio is part of this memory. ' : '') +
      (row.sdCapture ? 'SD capture' + sdQuality(row.sdCapture) + '. ' : '') +
      (row.timingEstimated ? 'Frame times estimated from the earlier 2 fps capture. ' : '') +
      (row.previewOnly
        ? 'Preview only. Original on SD: ' +
          row.sourcePath +
          '. Use Browse SD card or Wi-Fi downloads to retrieve it. '
        : '') +
      'Saved in this browser on this device. Export a copy before clearing browser data.';
    renderDescriptions();
    $('visualDetailStatus').textContent = '';
    showFrame(0);
    $('visualDialog').showModal();
    const journal = new root.DKAudioStore(),
      recordings = (await journal.all('recordings')).filter(
        (r) => r.ownerUid === expected && r.status !== 'recording',
      );
    if (token !== viewerGeneration || selected?.id !== id || expected !== api().state.owner) return;
    const select = $('visualAudioLink');
    select.replaceChildren(new Option('No linked audio', ''));
    for (const record of recordings)
      select.add(new Option(record.name || 'Audio recording', record.id));
    select.value = row.audioId || '';
    const audio = row.audioId ? await journal.get('recordings', row.audioId) : null;
    if (token !== viewerGeneration || selected?.id !== id || expected !== api().state.owner) return;
    $('visualAudio').hidden = true;
    $('visualAudioSource').hidden = audio?.ownerUid !== expected;
    $('visualAudioSource').href = '#recording-' + (audio?.id || '');
    if (audio?.ownerUid === expected) {
      const blob = await journal.blob(audio);
      if (token !== viewerGeneration || selected?.id !== id || api().state.owner !== expected)
        return;
      const url = URL.createObjectURL(blob);
      viewerUrls.push(url);
      $('visualAudio').src = url;
      $('visualAudio').hidden = false;
      if (video) {
        $('visualSoundLabel').hidden = false;
        player?.setAudio($('visualAudio'));
      }
    }
  }
  async function render() {
    const state = api().state,
      token = ++generation;
    const nextAccess = state.owner + ':' + state.available;
    if (owner !== state.owner || access !== nextAccess) {
      access = nextAccess;
      owner = state.owner;
      renderSignature = '';
      closeViewer();
      // Revoke old-account thumbnails immediately, before any asynchronous read.
      document.querySelectorAll('#recordingsList .library-media-card').forEach((card) => {
        disposeCard(card);
        card.remove();
      });
      root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
      $('visualSDList').replaceChildren();
    }
    $('visualAccess').textContent = state.available
      ? 'Chakshu capture & SD imports'
      : 'Unavailable';
    $('visualGate').hidden = state.available;
    $('visualGate').textContent = state.owner
      ? 'Connect Chakshu to associate it with this account and unlock photos and video.'
      : 'Sign in and associate a Chakshu device to unlock photos and video.';
    $('visualTools').hidden = !state.available;
    $('visualDeviceHint').textContent = !state.connected
      ? 'Your library is available. ' + state.connectionStatus.message
      : !state.mediaSupported
        ? 'Update Chakshu firmware for camera transfers. You can import files from its SD card now.'
        : !state.cameraReady
          ? 'Camera unavailable. Check hardware in Settings.'
          : 'Camera connected. Audio-only mode uses the usual recording and transcription flow.';
    $('visualStop').hidden = !state.session && !state.offline;
    $('visualStop').textContent = state.offline
      ? 'Stop SD recording'
      : state.session?.phase === 'saving'
        ? 'Saving…'
        : 'Stop video';
    $('visualStop').disabled = state.session?.phase === 'saving';
    const deviceBusy = root.SynapModules?.busy;
    const busy =
      state.working || Boolean(state.session) || state.offline || deviceBusy || state.wifi?.active;
    for (const [id, available] of Object.entries({
      visualPhoto: state.cameraReady,
      visualPhotoAudio: state.cameraReady,
      visualOnline: state.videoReady,
      visualRecordSD: state.offlineReady,
      visualSD: state.storageReady,
    }))
      $(id).disabled = busy || !state.connected || !available;
    $('visualImport').disabled = busy;
    const recording = root.SynapAppControls.recordingState().active;
    $('visualCheckSD').disabled = busy || recording || !state.connected || !state.mediaSupported;
    $('visualWifi').disabled =
      busy || recording || !state.connected || !state.storageReady || !state.wifiSupported;
    $('visualWifi').title = state.wifiSupported
      ? ''
      : 'Update Chakshu firmware for Wi-Fi downloads.';
    $('visualStorageHint').textContent = state.storageReady
      ? 'SD card ready. Record higher-quality video on the card, then import it here. Photos and phone video stay on this phone.'
      : 'No SD card is needed. Photos, video and soundtracks save only to this phone.';
    $('visualSDQuality').disabled = busy;
    $('visualSDLength').disabled = busy;
    $('visualSDVideoHint').textContent = !state.sdProfilesSupported
      ? 'Update Chakshu firmware to enable HD and smooth SD video.'
      : !state.storageReady
        ? 'Insert a card, then choose Check SD card.'
        : 'HD favours detail; Smooth favours motion. Frame rate varies with light and card speed. Clips stop at the selected length or 32 MiB, whichever comes first.';
    $('visualWifiDetails').hidden = !state.wifi?.active;
    $('visualWifiName').textContent = state.wifi?.ssid || '';
    $('visualWifiPassword').textContent = state.wifi?.password || '';
    if (state.wifi?.url) $('visualWifiOpen').href = state.wifi.url;
    else $('visualWifiOpen').removeAttribute('href');
    $('visualWifiStop').disabled = !state.connected || state.working;
    $('visualMode').disabled = busy;
    $('visualAudioOnly').disabled =
      state.offline || state.working || deviceBusy || state.wifi?.active;
    $('visualLive').hidden = !state.session?.id;
    if (!state.session?.id && liveUrl) {
      URL.revokeObjectURL(liveUrl);
      liveUrl = null;
      liveKey = '';
      $('visualLiveFrame').removeAttribute('src');
      $('visualLiveDescription').textContent = '';
    }
    $('visualConnectionStatus').textContent =
      state.error ||
      (state.session
        ? 'Saving camera frames and soundtrack on this phone…'
        : state.offline
          ? 'Recording to SD · ' +
            ((state.offlineStatus?.audioMs || 0) / 1000).toFixed(1) +
            ' s · ' +
            (state.offlineStatus?.frames || 0) +
            ' frames' +
            sdQuality(state.offlineStatus) +
            ' · limit ' +
            (state.offlineStatus?.clipLimitMs || 60000) / 1000 +
            ' s.'
          : state.wifi?.active
            ? 'Wi-Fi downloads active. Finish downloads before recording.'
            : state.offlineStatus?.path
              ? 'SD recording saved' +
                sdQuality(state.offlineStatus) +
                '. Choose Browse SD card or Wi-Fi downloads.'
              : '');
    if (!state.available) return;
    const store = api().store,
      rows = await store.list();
    if (token !== generation || store !== api().store) return;
    if (state.session?.id) {
      const take = rows.find((row) => row.id === state.session.id);
      const frame = await store.lastFrame(state.session.id);
      if (token !== generation || store !== api().store) return;
      const key = state.session.id + ':' + frame?.index;
      if (frame && key !== liveKey) {
        if (liveUrl) URL.revokeObjectURL(liveUrl);
        liveUrl = URL.createObjectURL(frame.blob);
        liveKey = key;
        $('visualLiveFrame').src = liveUrl;
      }
      const description = take?.descriptions?.at(-1);
      $('visualLiveDescription').textContent = description
        ? (description.atMs / 1000).toFixed(1) + ' s · ' + description.text
        : frame
          ? 'Camera frame · ' + (frame.atMs / 1000).toFixed(1) + ' s'
          : 'Waiting for the camera…';
    }
    const signature = JSON.stringify([
      state.owner,
      rows.map((row) => [
        row.id,
        row.name,
        row.notes,
        row.favourite,
        row.frameCount,
        row.state,
        row.audioId,
        row.durationMs,
      ]),
    ]);
    if (signature !== renderSignature) {
      renderSignature = signature;
      root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
    }
  }

  // Audio and visuals share the app's chronology, search, dates and pagination.
  // Prefix visual IDs so selection can never mistake them for cloud audio IDs.
  async function list() {
    const state = api().state,
      store = api().store;
    if (!state.available || !store) return [];
    const rows = await store.list();
    if (store !== api().store || state.owner !== api().state.owner || !api().state.available) return [];
    const local = rows.map((row) => ({
        ...row,
        id: 'visual:' + row.id,
        mediaId: row.id,
        mediaKind: row.kind,
        localOnly: true,
        sealed: row.state !== 'capturing',
        status: row.state === 'capturing' ? 'recording' : 'saved',
      })),
      imported = new Set(rows.filter((row) => row.state === 'saved' && row.sourceName).map((row) => row.sourceName)),
      sd = (state.sdFiles || [])
        .filter((file) => /\\.(jpg|mjpeg)$/i.test(file.path) && !imported.has(file.path.split('/').pop()))
        .map((file) => {
          const sourceName = file.path.split('/').pop(), mediaId = 'sd:' + encodeURIComponent(file.path), video = /\\.mjpeg$/i.test(file.path);
          return {
            id: 'visual:' + mediaId,
            mediaId,
            mediaKind: video ? 'video' : 'image',
            kind: video ? 'video' : 'image',
            ownerUid: state.owner,
            deviceId: state.sdFilesDeviceId || null,
            name: sourceName,
            sourceName,
            sourcePath: file.path,
            byteSize: file.bytes,
            createdAt: file.seenAt || new Date().toISOString(),
            localOnly: true,
            sealed: true,
            status: 'saved',
            state: 'sd-only',
            sdOnly: true,
          };
        });
    return local.concat(sd);
  }
  function disposeCard(card) {
    card.querySelectorAll?.('.library-media-card').forEach(disposeCard);
    card.synapThumbnailToken = null;
    if (card.synapThumbnailUrl) URL.revokeObjectURL(card.synapThumbnailUrl);
    card.synapThumbnailUrl = null;
  }
  function updateCard(card, row) {
    card.synapRecording = row;
    const title = row.name || (row.mediaKind === 'video' ? 'Video' : 'Photo'),
      opener = card.querySelector('.library-media-open'), image = card.querySelector('img'), preview = card.querySelector('.recording-row-preview');
    card.querySelector('.recording-row-name').textContent = title;
    if (row.sdOnly) {
      opener.setAttribute('aria-label', 'Move to app: ' + title);
      card.querySelector('.recording-row-meta').textContent = (row.mediaKind === 'video' ? 'Video' : 'Photo') + ' · On Chakshu SD · ' + byteLabel(row.byteSize);
      preview.textContent = 'Move to app';
      preview.hidden = false;
      disposeCard(card);
      image.removeAttribute('src');
      image.hidden = true;
      return;
    }
    opener.setAttribute('aria-label', (row.mediaKind === 'video' ? 'Play video: ' : 'Open photo: ') + title);
    card.querySelector('.recording-row-meta').textContent =
      (row.mediaKind === 'video'
        ? 'Video · ' + ((row.durationMs || 0) / 1000).toFixed(1) + ' s'
        : 'Photo') +
      ' · On this device · ' +
      new Date(row.createdAt).toLocaleString([], {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }) +
      (row.favourite ? ' · Favourite' : '') +
      (row.audioId ? ' · with audio' : '') +
      (row.state === 'interrupted' ? ' · interrupted' : '');
    preview.textContent = row.notes || '';
    preview.hidden = !row.notes;
    const key = row.ownerUid + ':' + row.mediaId + ':' + Boolean(row.frameCount);
    if (card.synapThumbnailKey === key) return;
    disposeCard(card);
    card.synapThumbnailKey = key;
    const store = api().store,
      token = {};
    card.synapThumbnailToken = token;
    store
      .firstFrame(row.mediaId)
      .then((first) => {
        if (
          !first ||
          token !== card.synapThumbnailToken ||
          store !== api().store ||
          row.ownerUid !== api().state.owner ||
          !api().state.available
        )
          return;
        const image = card.querySelector('img');
        card.synapThumbnailUrl = URL.createObjectURL(first.blob);
        image.src = card.synapThumbnailUrl;
        image.hidden = false;
      })
      .catch(() => {});
  }
  function createCard(row) {
    const card = document.createElement('article');
    card.id = 'recording-' + row.id;
    card.className = 'recording-card library-media-card';
    card.dataset.mediaId = row.mediaId;
    const header = document.createElement('div');
    header.className = 'recording-row';
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.className = 'library-media-open';
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.hidden = true;
    const copy = document.createElement('span');
    for (const cls of ['recording-row-name', 'recording-row-meta', 'recording-row-preview']) {
      const part = document.createElement('span');
      part.className = cls;
      copy.append(part);
    }
    opener.append(image, copy);
    opener.addEventListener('click', () => action(async () => {
      const item = card.synapRecording;
      if (item?.sdOnly) {
        await api().moveSD(item.sourcePath, (progress) => status('Moving from Chakshu SD · ' + Math.round(progress * 100) + '%'));
        await render();
        return 'Moved to app.';
      }
      return open(item.mediaId);
    }));
    header.append(opener);
    card.append(header);
    updateCard(card, row);
    return card;
  }
  async function remove(id, expectedOwner) {
    if (String(id).startsWith('sd:')) throw Error('Move this SD capture to the app before deleting it.');
    const state = api().state,
      store = api().store;
    if (!store || !state.available || state.owner !== expectedOwner)
      throw Error('The signed-in account changed. Please try again.');
    if (state.session?.id === id) throw Error('Stop video before deleting it.');
    const row = await store.get(id);
    if (store !== api().store || api().state.owner !== expectedOwner)
      throw Error('The signed-in account changed. Please try again.');
    if (row?.state === 'capturing') throw Error('Stop and save this capture before deleting it.');
    await store.remove(id);
    if (selected?.id === id) closeViewer();
    await render();
  }
  function mode() {
    const value = $('visualMode').value;
    for (const key of ['audio', 'image', 'video']) $('visualMode-' + key).hidden = value !== key;
  }
  function init() {
    const showAdd = (visible) => {
      $('visualLibrary').hidden = !visible;
      $('libraryAdd').setAttribute('aria-expanded', String(visible));
      if (visible) {
        root.SynapCompactLayout?.reveal('library');
        $('libraryAddTitle').tabIndex = -1;
        $('libraryAddTitle').focus({ preventScroll: true });
        $('visualLibrary').scrollIntoView({ block: 'nearest' });
      } else ($('libraryActionsToggle') || $('libraryAdd')).focus({ preventScroll: true });
    };
    $('libraryAdd').addEventListener('click', () => showAdd($('visualLibrary').hidden));
    $('libraryAddClose').addEventListener('click', () => showAdd(false));
    $('visualMode').addEventListener('change', mode);
    $('visualRetryAccess').addEventListener('click', () =>
      action(async () => {
        await root.SynapModules?.refresh();
        await api().sync();
      }),
    );
    $('visualAudioOnly').addEventListener('click', () =>
      action(() => root.SynapAppControls.toggleCapture()),
    );
    $('visualPhoto').addEventListener('click', () => action(async () => open(await api().photo())));
    $('visualPhotoAudio').addEventListener('click', () =>
      action(async () => open(await api().photo(true))),
    );
    $('visualOnline').addEventListener('click', () => action(() => api().startVideo()));
    $('visualRecordSD').addEventListener('click', () =>
      action(() =>
        api().startOffline(Number($('visualSDQuality').value), Number($('visualSDLength').value)),
      ),
    );
    $('visualCheckSD').addEventListener('click', () => action(() => api().refreshSD()));
    $('visualWifi').addEventListener('click', () => action(() => api().startWifi()));
    $('visualWifiStop').addEventListener('click', () => action(() => api().stopWifi()));
    $('visualWifiCopy').addEventListener('click', () => {
      const password = api().state.wifi?.password;
      if (password && navigator.clipboard)
        navigator.clipboard.writeText(password).then(
          () => status('Wi-Fi password copied.'),
          () => status('Select and copy the displayed password.'),
        );
      else status('Select and copy the displayed password.');
    });
    $('visualStop').addEventListener('click', () => action(() => api().stop()));
    $('visualImport').addEventListener('click', () => $('visualFiles').click());
    $('visualFiles').addEventListener('change', () =>
      action(async () => {
        const files = [...$('visualFiles').files];
        $('visualFiles').value = '';
        await api().importFiles(files);
        render();
      }),
    );
    $('visualSD').addEventListener('click', () =>
      action(async () => {
        const files = await api().catalogue(),
          list = $('visualSDList');
        list.replaceChildren();
        if (!files.length) list.textContent = 'No photos or videos on the SD card.';
        for (const file of files)
          list.append(
            button('Import ' + file.path.split('/').pop(), async () => {
              await api().importSD(file.path, (p) =>
                status('Importing from SD · ' + Math.round(p * 100) + '%'),
              );
              render();
            }),
          );
      }),
    );
    $('visualClose').addEventListener('click', closeViewer);
    $('visualAudioSource').addEventListener('click', (event) => {
      if (!selected?.audioId) return;
      const audioId = selected.audioId;
      if (root.SynapProvenance?.openSource) {
        event.preventDefault();
        closeViewer();
        root.SynapProvenance.openSource(audioId);
      } else closeViewer();
    });
    $('visualDialog').addEventListener('cancel', (e) => {
      e.preventDefault();
      closeViewer();
    });
    $('visualSeek').addEventListener('input', () => {
      player?.seek(Number($('visualSeek').value));
    });
    $('visualPlay').addEventListener('click', () => {
      if (player?.playing) pause();
      else {
        const context = viewContext();
        player?.play().catch((error) => {
          if (context.current())
            $('visualDetailStatus').textContent =
              'Playback could not start. Try again or turn off linked audio. ' + error.message;
        });
      }
    });
    $('visualSpeed').addEventListener('change', () => player?.setRate($('visualSpeed').value));
    $('visualSound').addEventListener('change', () =>
      player?.setAudio($('visualSound').checked ? $('visualAudio') : null),
    );
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') pause();
    });
    for (const [id, step] of [
      ['visualPreviousFrame', -1],
      ['visualNextFrame', 1],
    ])
      $(id).addEventListener('click', () => {
        pause();
        showFrame(frameIndex + step);
      });
    $('visualZoom').addEventListener('click', () => {
      const zoomed = $('visualStage').classList.toggle('zoomed');
      $('visualZoom').setAttribute('aria-pressed', String(zoomed));
      $('visualZoom').textContent = zoomed ? 'Fit view' : 'Zoom view';
    });
    $('visualFavourite').addEventListener('click', () =>
      detailAction('visualFavourite', async (context) => {
        const favourite = !selected.favourite;
        await context.store.patch(context.id, { favourite });
        if (context.current()) {
          selected.favourite = favourite;
          renderFavourite();
          await render();
        }
        return favourite ? 'Added to favourites.' : 'Removed from favourites.';
      }),
    );
    $('visualSaveDetails').addEventListener('click', () =>
      detailAction('visualSaveDetails', async (context) => {
        const fields = {
          name: $('visualName').value.trim().slice(0, 160),
          notes: $('visualNotes').value.trim().slice(0, 2000),
        };
        if (!fields.name) throw Error('Enter a title before saving.');
        await context.store.patch(context.id, fields);
        if (context.current()) {
          Object.assign(selected, fields);
          $('visualTitle').textContent = fields.name;
          await render();
        }
        return 'Title and notes saved.';
      }),
    );
    $('visualSaveFrame').addEventListener('click', () =>
      detailAction('visualSaveFrame', async (context) => {
        pause();
        const id = await context.store.savePhotoFrame(
          context.id,
          selectedFrames[frameIndex]?.index,
        );
        if (!id) throw Error('This frame is no longer available.');
        if (context.current()) await render();
        return 'Photo saved to your library. Its audio link is kept.';
      }),
    );
    $('visualSaveLink').addEventListener('click', () =>
      detailAction('visualSaveLink', async (context) => {
        const audioId = $('visualAudioLink').value || null;
        if (audioId) {
          const audio = await new root.DKAudioStore().get('recordings', audioId);
          if (!context.current()) return;
          if (!audio || audio.ownerUid !== api().state.owner || audio.status === 'recording')
            throw Error('Choose a saved recording from this account.');
        }
        await context.store.patch(context.id, { audioId });
        if (context.current()) {
          await open(context.id);
          await render();
        }
      }),
    );
    $('visualDownload').addEventListener('click', () => {
      if (!selected) return;
      download(
        new Blob(
          selectedFrames.map((frame) => frame.blob),
          { type: selected.kind === 'image' ? 'image/jpeg' : 'video/x-motion-jpeg' },
        ),
        'chakshu-' + selected.id + (selected.kind === 'image' ? '.jpg' : '.mjpeg'),
      );
      if (selected.kind === 'video')
        download(
          new Blob(
            [
              JSON.stringify({
                schema: 1,
                frameTimesMs: selectedFrames.map((frame) => frame.atMs),
                durationMs: selected.durationMs,
                audioId: selected.audioId,
              }),
            ],
            { type: 'application/json' },
          ),
          'chakshu-' + selected.id + '.json',
        );
    });
    $('visualDelete').addEventListener('click', () =>
      action(async () => {
        if (!selected) return;
        const id = selected.id;
        if (api().state.session?.id === id) throw Error('Stop video before deleting it.');
        await api().store.remove(id);
        closeViewer();
        render();
      }),
    );
    root.addEventListener('synap-chakshu-changed', () => render().catch((e) => status(e.message)));
    root.addEventListener('synap-module-changed', () => render().catch((e) => status(e.message)));
    root.addEventListener('synap-chakshu-offline', (e) => {
      if (e.detail.active) status('SD recording · ' + e.detail.progress + '%');
      else if (e.detail.path)
        status(
          'Saved on SD. Choose Browse SD card to import ' + e.detail.path.split('/').pop() + '.',
        );
    });
    mode();
    render().catch((e) => status(e.message));
  }
  root.SynapChakshuLibrary = {
    open,
    close: closeViewer,
    list,
    createCard,
    updateCard,
    disposeCard,
    remove,
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
