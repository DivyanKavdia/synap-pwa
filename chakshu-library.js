/* Mounted photo/video surface. Model output is always text, never executable markup. */
(function (root) {
  'use strict';
  const $ = (id) => document.getElementById(id),
    api = () => root.SynapChakshu;
  let owner = '',
    generation = 0,
    viewerGeneration = 0,
    urls = [],
    viewerUrls = [],
    player = null,
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
    $('visualPrompt').value = '';
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
    for (const id of [
      'visualSaveFrame',
      'visualFavourite',
      'visualSaveDetails',
      'visualDescribe',
      'visualReadText',
      'visualSaveLink',
    ])
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
    $('visualDescribe').disabled = !frames.length;
    $('visualReadText').disabled = !frames.length;
    $('visualDownload').disabled = !frames.length;
    $('visualZoom').disabled = !frames.length;
    $('visualPlay').disabled = !frames.length;
    $('visualName').value = row.name || '';
    $('visualNotes').value = row.notes || '';
    renderFavourite();
    $('visualInfo').textContent =
      (row.state === 'interrupted' ? 'Interrupted capture · ' : '') +
      (video ? 'Video playback · audio remains a separate recording. ' : '') +
      (row.timingEstimated ? 'Frame times estimated from the earlier 2 fps capture. ' : '') +
      'Saved on this browser.';
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
    if (owner !== state.owner) {
      owner = state.owner;
      pageSize = 40;
      $('visualSearch').value = '';
      $('visualFilter').value = 'all';
      $('visualFavourites').setAttribute('aria-pressed', 'false');
      $('visualCount').textContent = '';
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
    const deviceBusy = root.SynapChakshuModel?.busy || root.SynapModules?.busy;
    const busy = state.working || Boolean(state.session) || state.offline || deviceBusy;
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
    $('visualAudioOnly').disabled = state.offline || state.working || deviceBusy;
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
      query = $('visualSearch').value,
      favourites = $('visualFavourites').getAttribute('aria-pressed') === 'true',
      visible = root.SynapVisualStore.filterMedia(rows, { kind: filter, query, favourites });
    $('visualCount').textContent = visible.length + ' of ' + rows.length + ' saved items';
    $('visualClearSearch').hidden = !query && filter === 'all' && !favourites;
    const signature = JSON.stringify([
      state.owner,
      filter,
      query,
      favourites,
      pageSize,
      rows.map((row) => [
        row.id,
        row.name,
        row.notes,
        row.favourite,
        row.frameCount,
        row.state,
        row.audioId,
        row.descriptions?.length,
      ]),
    ]);
    if (signature === renderSignature) return;
    const grid = $('visualGrid');
    const fragment = document.createDocumentFragment(),
      nextUrls = [];
    if (!visible.length) {
      const p = document.createElement('p');
      p.className = 'visual-empty';
      p.textContent = rows.length
        ? 'No matching photos or videos. Try clearing the filters.'
        : 'Your photos and video clips will appear here.';
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
      card.setAttribute(
        'aria-label',
        (row.kind === 'video' ? 'Play video: ' : 'Open photo: ') + (row.name || row.kind),
      );
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
      if (row.kind === 'video') {
        const badge = document.createElement('span');
        badge.className = 'visual-play-badge';
        badge.textContent = '▶ Play video';
        card.append(badge);
      }
      const title = document.createElement('strong');
      title.textContent = row.name || (row.kind === 'video' ? 'Video' : 'Photo');
      const meta = document.createElement('span');
      meta.textContent =
        (row.kind === 'video' ? 'Video' : 'Photo') +
        (row.favourite ? ' · Favourite' : '') +
        (row.kind === 'video' ? ' · ' + ((row.durationMs || 0) / 1000).toFixed(1) + ' s' : '') +
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
    const refreshFilters = () => {
      pageSize = 40;
      render().catch((e) => status(e.message));
    };
    $('visualFilter').addEventListener('change', refreshFilters);
    $('visualSearch').addEventListener('input', refreshFilters);
    $('visualFavourites').addEventListener('click', () => {
      $('visualFavourites').setAttribute(
        'aria-pressed',
        String($('visualFavourites').getAttribute('aria-pressed') !== 'true'),
      );
      refreshFilters();
    });
    $('visualClearSearch').addEventListener('click', () => {
      $('visualSearch').value = '';
      $('visualFilter').value = 'all';
      $('visualFavourites').setAttribute('aria-pressed', 'false');
      refreshFilters();
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
    const describe = (id, prompt) =>
      detailAction(id, async (context) => {
        pause();
        await api().describe(context.id, selectedFrames[frameIndex]?.atMs || 0, prompt);
        const row = await context.store.get(context.id);
        if (context.current() && row) {
          selected.descriptions = row.descriptions;
          renderDescriptions();
          await render();
        }
        return 'Description saved.';
      });
    $('visualDescribe').addEventListener('click', () =>
      describe(
        'visualDescribe',
        $('visualPrompt').value.trim() || 'Describe what is visible here.',
      ),
    );
    $('visualReadText').addEventListener('click', () =>
      describe(
        'visualReadText',
        'Read the text visible in this view. Preserve its reading order and say when text is unclear.',
      ),
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
  root.SynapChakshuLibrary = { open, close: closeViewer };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
