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
    $('capturePreviewWaiting').textContent =
      state.error ||
      note ||
      receiving ||
      (active ? 'Waiting for the first video frame…' : 'No camera image yet.');
    $('capturePreviewStatus').textContent =
      note ||
      state.error ||
      (stopping
        ? 'Saving video and audio…'
        : receiving
          ? receiving
          : active
            ? frame
              ? 'Recording · ' + root.SynapChakshuPlayer.timeLabel(frame.atMs)
              : 'Preparing video and separate audio…'
            : row
              ? row.kind === 'video'
                ? 'Video saved. Audio is saved separately.'
                : 'Photo saved to your library.'
              : busy
                ? 'Taking photo…'
                : 'Capture unavailable.');
    $('capturePreviewHint').textContent = active
      ? stopping
        ? 'Finishing the recording and saving received frames and audio…'
        : 'Closing this preview keeps recording. Use Stop & save video to finish.'
      : row
        ? 'You can review this capture in your library.'
        : '';
    $('capturePreviewPhoto').hidden = mode !== 'video' || !active;
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
      else await api().startLive(false);
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
