/* Mounted photo/video surface. Model output is always text, never executable markup. */
(function (root) {
  'use strict';
  const $ = (id) => document.getElementById(id),
    api = () => root.SynapChakshu;
  let owner = '',
    generation = 0,
    urls = [],
    viewerUrls = [],
    playTimer = null,
    selected = null,
    selectedFrames = [],
    frameIndex = 0,
    pageSize = 40,
    liveUrl = null,
    liveKey = '',
    renderSignature = '';
  const revoke = (list) => {
    for (const url of list) URL.revokeObjectURL(url);
    list.length = 0;
  };
  function status(message) {
    $('visualStatus').textContent = message || '';
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
    clearTimeout(playTimer);
    playTimer = null;
    revoke(viewerUrls);
    selected = null;
    selectedFrames = [];
    $('visualDialog').close();
    $('visualPreview').removeAttribute('src');
    $('visualAudio').pause();
    $('visualAudio').removeAttribute('src');
  }
  function showFrame(index) {
    frameIndex = Math.max(0, Math.min(index, selectedFrames.length - 1));
    if (!selectedFrames[frameIndex]) return;
    $('visualPreview').src = viewerUrls[frameIndex];
    $('visualSeek').value = frameIndex;
    $('visualTime').textContent = (selectedFrames[frameIndex].atMs / 1000).toFixed(1) + ' s';
  }
  function play() {
    clearTimeout(playTimer);
    if (!selectedFrames.length) return;
    if (frameIndex >= selectedFrames.length - 1) showFrame(0);
    const next = () => {
      if (!selected || frameIndex >= selectedFrames.length - 1) {
        $('visualPlay').textContent = 'Play video';
        playTimer = null;
        return;
      }
      const ms = Math.max(
        50,
        selectedFrames[frameIndex + 1].atMs - selectedFrames[frameIndex].atMs,
      );
      playTimer = setTimeout(() => {
        showFrame(frameIndex + 1);
        next();
      }, ms);
    };
    $('visualPlay').textContent = 'Pause video';
    next();
  }
  async function open(id) {
    const store = api().store,
      expected = api().state.owner;
    const row = await store.get(id),
      frames = await store.frames(id);
    if (expected !== api().state.owner || !row) return;
    closeViewer();
    selected = row;
    selectedFrames = frames;
    for (const frame of frames) viewerUrls.push(URL.createObjectURL(frame.blob));
    $('visualTitle').textContent = row.name || (row.kind === 'image' ? 'Photo' : 'Video');
    $('visualSeek').max = Math.max(0, frames.length - 1);
    $('visualSeek').hidden = row.kind !== 'video';
    $('visualPlay').hidden = row.kind !== 'video';
    $('visualPlay').textContent = 'Play video';
    $('visualInfo').textContent =
      (row.state === 'interrupted' ? 'Interrupted capture · ' : '') +
      (row.kind === 'video' ? 'Silent video · audio is saved separately. ' : '') +
      (row.timingEstimated ? 'Frame times estimated from the earlier 2 fps capture. ' : '') +
      'Saved on this browser.';
    $('visualDescriptions').replaceChildren();
    for (const description of row.descriptions || []) {
      const p = document.createElement('p');
      p.textContent = (description.atMs / 1000).toFixed(1) + ' s · ' + description.text;
      $('visualDescriptions').append(p);
    }
    $('visualDetailStatus').textContent = '';
    showFrame(0);
    $('visualDialog').showModal();
    const journal = new root.DKAudioStore(),
      recordings = (await journal.all('recordings')).filter(
        (r) => r.ownerUid === expected && r.status !== 'recording',
      );
    if (selected?.id !== id || expected !== api().state.owner) return;
    const select = $('visualAudioLink');
    select.replaceChildren(new Option('No linked audio', ''));
    for (const record of recordings)
      select.add(new Option(record.name || 'Audio recording', record.id));
    select.value = row.audioId || '';
    const audio = row.audioId ? await journal.get('recordings', row.audioId) : null;
    if (selected?.id !== id || expected !== api().state.owner) return;
    $('visualAudio').hidden = true;
    $('visualAudioSource').hidden = audio?.ownerUid !== expected;
    $('visualAudioSource').href = '#recording-' + (audio?.id || '');
    if (audio?.ownerUid === expected) {
      const blob = await journal.blob(audio);
      if (selected?.id !== id || api().state.owner !== expected) return;
      const url = URL.createObjectURL(blob);
      viewerUrls.push(url);
      $('visualAudio').src = url;
      $('visualAudio').hidden = false;
    }
  }
  async function render() {
    const state = api().state,
      token = ++generation;
    if (owner !== state.owner) {
      owner = state.owner;
      pageSize = 40;
      renderSignature = '';
      closeViewer();
      revoke(urls);
      $('visualGrid').replaceChildren();
      $('visualSDList').replaceChildren();
    }
    $('visualAccess').textContent = state.available ? 'Chakshu library' : 'Unavailable';
    $('visualGate').hidden = state.available;
    $('visualGate').textContent = state.owner
      ? 'Connect Chakshu to associate it with this account and unlock photos and video.'
      : 'Sign in and associate a Chakshu device to unlock photos and video.';
    $('visualTools').hidden = !state.available;
    $('visualGrid').hidden = !state.available;
    $('visualDeviceHint').textContent = !state.connected
      ? 'Your library is available. Connect Chakshu for camera capture.'
      : !state.cameraReady
        ? 'Update Chakshu firmware for camera transfers. You can import files from its SD card now.'
        : 'Camera connected. Audio-only mode uses the usual recording and transcription flow.';
    $('visualStop').hidden = !state.session && !state.offline;
    $('visualStop').textContent = state.offline
      ? 'Stop SD recording'
      : state.session?.phase === 'saving'
        ? 'Saving…'
        : 'Stop video';
    $('visualStop').disabled = state.session?.phase === 'saving';
    const busy = state.working || Boolean(state.session) || state.offline;
    for (const id of [
      'visualPhoto',
      'visualPhotoAudio',
      'visualOnline',
      'visualOffline',
      'visualSD',
    ])
      $(id).disabled = busy || !state.connected || !state.cameraReady;
    $('visualImport').disabled = busy;
    $('visualMode').disabled = busy;
    $('visualExplainLive').hidden = !state.session?.id;
    $('visualAudioOnly').disabled = state.offline || state.working;
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
        ? 'Recording camera frames and separate audio…'
        : state.offline
          ? 'Recording to Chakshu’s SD card · up to 60 seconds.'
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
    const filter = $('visualFilter').value,
      visible = rows.filter((row) => filter === 'all' || row.kind === filter);
    const signature = JSON.stringify([
      state.owner,
      filter,
      pageSize,
      rows.map((row) => [row.id, row.frameCount, row.state, row.audioId, row.descriptions?.length]),
    ]);
    if (signature === renderSignature) return;
    const grid = $('visualGrid');
    const fragment = document.createDocumentFragment(),
      nextUrls = [];
    if (!visible.length) {
      const p = document.createElement('p');
      p.className = 'visual-empty';
      p.textContent = 'Your photos and video clips will appear here.';
      fragment.append(p);
    }
    // Keep a large library responsive; its original media is loaded only on open.
    for (const row of visible.slice(0, pageSize)) {
      const first = await store.firstFrame(row.id);
      if (token !== generation || store !== api().store) {
        revoke(nextUrls);
        return;
      }
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'visual-card';
      card.dataset.mediaId = row.id;
      if (first) {
        const image = document.createElement('img'),
          url = URL.createObjectURL(first.blob);
        nextUrls.push(url);
        image.src = url;
        image.alt = '';
        image.loading = 'lazy';
        card.append(image);
      }
      const title = document.createElement('strong');
      title.textContent = row.name || (row.kind === 'video' ? 'Video' : 'Photo');
      const meta = document.createElement('span');
      meta.textContent =
        (row.kind === 'video' ? 'Video' : 'Photo') +
        ' · ' +
        new Date(row.createdAt).toLocaleDateString() +
        (row.audioId ? ' · with audio' : '') +
        (row.state === 'interrupted' ? ' · interrupted' : '');
      card.append(title, meta);
      card.addEventListener('click', () => action(() => open(row.id)));
      fragment.append(card);
    }
    if (visible.length > pageSize)
      fragment.append(
        button('Show more', async () => {
          pageSize += 40;
          await render();
        }),
      );
    revoke(urls);
    urls = nextUrls;
    grid.replaceChildren(fragment);
    renderSignature = signature;
  }
  function mode() {
    const value = $('visualMode').value;
    for (const key of ['audio', 'image', 'video']) $('visualMode-' + key).hidden = value !== key;
  }
  function init() {
    $('visualMode').addEventListener('change', mode);
    $('visualFilter').addEventListener('change', () => {
      pageSize = 40;
      render();
    });
    $('visualRetryAccess').addEventListener('click', () => action(() => api().sync()));
    $('visualAudioOnly').addEventListener('click', () =>
      action(() => root.SynapAppControls.toggleCapture()),
    );
    $('visualPhoto').addEventListener('click', () => action(async () => open(await api().photo())));
    $('visualPhotoAudio').addEventListener('click', () =>
      action(async () => open(await api().photo(true))),
    );
    $('visualOnline').addEventListener('click', () =>
      action(() => api().startLive($('visualInference').checked)),
    );
    $('visualOffline').addEventListener('click', () => action(() => api().startOffline()));
    $('visualStop').addEventListener('click', () => action(() => api().stop()));
    $('visualExplainLive').addEventListener('click', () =>
      action(async () => {
        const id = api().state.session?.id;
        if (id) {
          const audio = root.SynapAppControls.recordingState();
          const result = await api().describe(id, audio.offsetMs);
          return result.text;
        }
      }),
    );
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
    $('visualDialog').addEventListener('cancel', (e) => {
      e.preventDefault();
      closeViewer();
    });
    $('visualSeek').addEventListener('input', () => {
      clearTimeout(playTimer);
      playTimer = null;
      $('visualPlay').textContent = 'Play video';
      showFrame(Number($('visualSeek').value));
    });
    $('visualPlay').addEventListener('click', () => {
      if (playTimer) {
        clearTimeout(playTimer);
        playTimer = null;
        $('visualPlay').textContent = 'Play video';
      } else play();
    });
    $('visualDescribe').addEventListener('click', async () => {
      if (!selected) return;
      const id = selected.id,
        index = frameIndex;
      const button = $('visualDescribe');
      button.disabled = true;
      $('visualDetailStatus').textContent = 'Looking at the selected frames…';
      try {
        await api().describe(
          id,
          selectedFrames[index]?.atMs || 0,
          $('visualPrompt').value.trim() || 'Describe what is visible here.',
        );
        if (selected?.id === id) await open(id);
      } catch (e) {
        $('visualDetailStatus').textContent = e.message;
      } finally {
        button.disabled = false;
      }
    });
    $('visualSaveLink').addEventListener('click', () =>
      action(async () => {
        if (!selected) return;
        const id = selected.id;
        await api().store.patch(id, { audioId: $('visualAudioLink').value || null });
        await open(id);
        render();
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
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
