/* Product-facing capture controls. Core BLE/recording behavior remains in app.js. */
(function () {
  'use strict';
  globalThis.SynapCaptureUIRevision = '1.0.0-chakshu-core9';
  const TAGLINE = 'Stay present. Keep the memory.';
  const PUBLIC_VERSION = '1.0.0';
  const logoSource = () =>
    window.SynapAppearance?.logoSource() ||
    'synap-logo-' +
      (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light') +
      '.png?v=1.0.0-ui-fix1';
  const ACTIVE_STATES = new Set(['idle', 'recording', 'starting', 'stopping', 'saving']);
  const RECORDING_STATES = new Set(['recording', 'starting']);
  const BUSY_STATES = new Set(['stopping', 'saving', 'updating', 'connecting']);

  function syncBrand() {
    const LOGO = logoSource();
    const headerLogo = document.querySelector('.topbar .brand-logo');
    if (headerLogo) {
      headerLogo.src = LOGO;
      headerLogo.alt = 'synap';
      headerLogo.classList.add('synap-brand-image');
    }
  }

  function init() {
    syncBrand();
    try {
      sessionStorage.removeItem('synap-continuous-capture');
    } catch (_) {}
    document
      .querySelectorAll('#retrySaveButton,#recoveryButton,#runQueueButton,#pauseQueueButton')
      .forEach((node) => {
        node.hidden = true;
        node.setAttribute('aria-hidden', 'true');
      });
    const header = document.querySelector('.topbar');
    const actions = document.querySelector('.top-actions');
    const section = document.getElementById('capture');
    const connect = document.getElementById('connectButton');
    const start = document.getElementById('startButton');
    const stop = document.getElementById('stopButton');
    const timer = document.getElementById('timer');
    const settings = document.getElementById('settingsButton');
    settings?.addEventListener('click', () => requestAnimationFrame(syncBrand));
    if (!header || !actions || !section || !connect || !start || !stop || !settings) return;

    document.title = 'synap · ' + TAGLINE;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', 'synap — ' + TAGLINE);
    const appVersion = document.getElementById('appVersion');
    if (appVersion) appVersion.textContent = PUBLIC_VERSION;

    /* Processing is automatic/product-managed. Low-level queue controls stay internal. */
    const processing = document.getElementById('processing');
    if (processing) processing.hidden = true;

    // Core control nodes remain mounted; the header owns their visible controls.
    section.hidden = true;
    const sessionBar = document.createElement('div');
    sessionBar.id = 'recordingSessionBar';
    sessionBar.hidden = true;
    const mark = document.createElement('button');
    mark.id = 'markMoment';
    mark.type = 'button';
    mark.textContent = '★ Mark moment';
    const feedback = document.createElement('span');
    feedback.id = 'momentFeedback';
    feedback.setAttribute('role', 'status');
    const reception = document.createElement('span');
    reception.id = 'audioReceptionStatus';
    reception.setAttribute('role', 'status');
    if (timer) {
      timer.setAttribute('aria-label', 'Elapsed recording time');
      sessionBar.append(timer, reception);
    }
    sessionBar.append(feedback, mark);
    header.append(sessionBar);
    let marking = false;
    mark.addEventListener('click', async () => {
      if (marking) return;
      marking = true;
      mark.disabled = true;
      try {
        await window.SynapMoments.mark();
        feedback.textContent = 'Moment saved';
      } catch (error) {
        feedback.textContent = error.message || 'Could not save moment. Try again.';
      } finally {
        marking = false;
        sync();
      }
    });

    let status = document.getElementById('headerPendantStatus');
    if (!status) {
      status = document.createElement('button');
      status.id = 'headerPendantStatus';
      status.className = 'header-pendant-status';
      status.type = 'button';
      status.setAttribute('aria-label', 'Pendant connection');
      status.innerHTML =
        '<span class="header-status-dot" aria-hidden="true"></span><span class="header-status-text">Offline</span>';
      status.addEventListener('click', () => window.SynapAppControls?.toggleConnection());
    }

    let toggle = document.getElementById('headerCaptureToggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.id = 'headerCaptureToggle';
      toggle.className = 'header-capture-toggle';
      toggle.type = 'button';
      toggle.setAttribute('aria-label', 'Start listening');
      toggle.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8"/></svg><span class="header-stop" aria-hidden="true"></span>';
      toggle.addEventListener('click', () => {
        if (window.SynapDesktopCapture?.state()?.active) {
          window.SynapDesktopCapture.stop('header-stop').catch((error) => {
            feedback.textContent = error.message || 'Could not save. Retry saving.';
          });
        } else if (window.SynapChakshu?.state.session || window.SynapChakshu?.state.offline) {
          mediaAction(() => window.SynapChakshu.setAudio(true));
        } else window.SynapAppControls?.toggleCapture();
      });
    }

    // Keep order deterministic across hot reloads and cached installs.
    if (status.parentNode !== actions) actions.prepend(status);
    if (toggle.parentNode !== actions) actions.insertBefore(toggle, settings);

    const captureNotice = document.createElement('p');
    captureNotice.id = 'headerMediaNotice';
    captureNotice.className = 'header-media-notice';
    captureNotice.setAttribute('role', 'status');
    captureNotice.hidden = true;
    header.append(captureNotice);
    let mediaPending = false,
      noticeTimer;
    function captureMessage(message) {
      clearTimeout(noticeTimer);
      captureNotice.textContent = message || '';
      captureNotice.hidden = !message;
      noticeTimer = setTimeout(() => {
        captureNotice.hidden = true;
      }, 7000);
    }
    async function mediaAction(action) {
      if (mediaPending) return;
      mediaPending = true;
      sync();
      try {
        await action();
      } catch (error) {
        captureMessage(error.message || 'Capture unavailable.');
      } finally {
        mediaPending = false;
        sync();
      }
    }
    const photo = document.createElement('button');
    photo.id = 'headerPhoto';
    photo.type = 'button';
    photo.className = 'header-capture-toggle header-media-button';
    photo.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l2-3h4l2 3h5v16H3V5z"/><circle cx="12" cy="12" r="4"/></svg>';
    photo.addEventListener('click', () =>
      mediaAction(async () => {
        await window.SynapChakshuPreview.photo();
        captureMessage('Photo saved');
      }),
    );
    const video = document.createElement('button');
    video.id = 'headerVideo';
    video.type = 'button';
    video.className = 'header-capture-toggle header-media-button';
    video.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 9 6-4v14l-6-4"/></svg><span class="header-stop" aria-hidden="true"></span>';
    video.addEventListener('click', () =>
      mediaAction(async () => {
        await window.SynapChakshuPreview.video();
      }),
    );
    actions.insertBefore(photo, settings);
    actions.insertBefore(video, settings);
    window.addEventListener('synap-chakshu-changed', sync);
    window.addEventListener('synap-module-changed', sync);

    let desktopClock = null;
    function updateDesktopClock() {
      const desktop = window.SynapDesktopCapture?.state();
      if (!timer || !desktop?.startedAt) return;
      const elapsed = Math.max(
        0,
        Math.floor(((desktop.stoppedAt || Date.now()) - desktop.startedAt) / 1000),
      );
      const hours = Math.floor(elapsed / 3600),
        minutes = Math.floor(elapsed / 60) % 60,
        seconds = elapsed % 60;
      timer.textContent =
        (hours ? String(hours).padStart(2, '0') + ':' : '') +
        String(minutes).padStart(2, '0') +
        ':' +
        String(seconds).padStart(2, '0');
    }
    function sync() {
      const state = document.body.dataset.state || 'disconnected';
      const ready = document.body.dataset.startup === 'ready';
      const interrupted = document.body.dataset.recordingInterrupted === 'true';
      const delivery = document.body.dataset.audioDelivery || 'idle';
      const delayed = delivery === 'delayed';
      const waiting = delivery === 'waiting' || delivery === 'recovering' || delayed;
      const recording = RECORDING_STATES.has(state);
      const finishing = state === 'stopping' || document.body.dataset.recordingFinishing === 'true';
      const canStop = !stop.disabled;
      const connected = ACTIVE_STATES.has(state);
      const busy = BUSY_STATES.has(state);
      sessionBar.hidden =
        !['starting', 'recording', 'stopping', 'saving'].includes(state) &&
        document.body.dataset.recordingInterrupted !== 'true';
      mark.hidden = state !== 'recording';
      mark.disabled = marking || state !== 'recording' || interrupted || waiting;
      reception.hidden = !recording && !finishing;
      reception.textContent = finishing
        ? (document.body.dataset.receivedAudioClock || '00:00') + ' audio received · finishing…'
        : delivery === 'recovering'
          ? 'Recovering audio…'
          : delayed
            ? (document.body.dataset.receivedAudioClock || '00:00') + ' audio received · delayed'
            : waiting
              ? 'No audio arriving'
              : (document.body.dataset.receivedAudioClock || '00:00') + ' audio received';
      reception.dataset.waiting = String(waiting);
      if (sessionBar.hidden) feedback.textContent = '';
      status.classList.toggle('is-connected', connected);
      status.classList.toggle('is-recording', recording && !waiting);
      const label = status.querySelector('.header-status-text');
      if (label)
        label.textContent =
          state === 'saving'
            ? 'Saving'
            : finishing
              ? 'Finishing'
              : state === 'updating'
                ? 'Updating'
                : interrupted
                  ? 'Paused'
                  : recording && delayed
                    ? 'Audio delayed'
                    : recording && waiting
                      ? 'Waiting'
                      : recording
                        ? 'Listening'
                        : connected
                          ? 'Connected'
                          : state === 'connecting'
                            ? 'Connecting'
                            : 'Connect';
      status.disabled = connect.disabled;
      status.setAttribute('aria-label', connected ? 'Disconnect pendant' : 'Connect pendant');
      toggle.classList.toggle('is-connected', connected || state === 'updating');
      toggle.classList.toggle('is-recording', recording || canStop || finishing);
      toggle.disabled =
        !ready || (!canStop && (busy || state === 'unsupported' || (connected && start.disabled)));
      const action =
        finishing && !canStop
          ? 'Finishing recording'
          : canStop
            ? interrupted
              ? 'Save received recording'
              : 'Stop listening'
            : !connected
              ? 'Connect and start listening'
              : 'Start listening';
      toggle.setAttribute('aria-label', action);
      toggle.title = action;
      const media = window.SynapChakshu?.state,
        visualActive = Boolean(media?.session || media?.offline);
      const module = window.SynapModules?.client?.module;
      const audioOnly = module && window.SynapCapabilities?.profile(module) && !window.SynapCapabilities.supports(module, 'camera');
      photo.hidden = video.hidden = Boolean(audioOnly && !visualActive);
      const visualReady =
        ready &&
        media?.available &&
        media?.connected &&
        !busy &&
        !mediaPending &&
        !media?.wifi?.active &&
        !media?.working &&
        !window.SynapModules?.busy;
      if (media?.wifi?.active) toggle.disabled = true;
      photo.disabled =
        !visualReady || !media?.cameraReady || media?.offline || media?.session?.phase === 'saving';
      const unavailable = !media?.available
        ? 'Unavailable — associate Chakshu with this account'
        : !media?.connected
          ? media?.connectionStatus?.message || 'Connect Chakshu to capture'
          : !media?.mediaSupported
            ? 'Update Chakshu firmware for camera capture'
            : 'Camera or microphone unavailable. Check device hardware.';
      photo.setAttribute(
        'aria-label',
        visualReady && media?.cameraReady ? 'Take photo' : unavailable,
      );
      photo.title = photo.getAttribute('aria-label');
      video.disabled =
        !visualReady ||
        (!visualActive && !media?.videoReady) ||
        media?.session?.phase === 'starting' ||
        media?.session?.phase === 'saving';
      video.setAttribute(
        'aria-label',
        visualActive
          ? 'Stop video recording'
          : visualReady && media?.videoReady
            ? 'Record video on phone'
            : unavailable,
      );
      video.title = video.getAttribute('aria-label');
      video.setAttribute('aria-pressed', String(visualActive));
      video.classList.toggle('is-recording', visualActive);
      if (visualActive) {
        toggle.classList.remove('is-recording');
        toggle.setAttribute('aria-label', 'Save video and switch to audio only');
        toggle.title = 'Save video and switch to audio only';
        toggle.disabled =
          !visualReady ||
          media?.session?.phase === 'starting' ||
          media?.session?.phase === 'saving';
      }
      const desktop = window.SynapDesktopCapture?.state();
      if (desktop?.active) {
        photo.disabled = true;
        video.disabled = true;
        reception.hidden = true;
        timer?.setAttribute('aria-label', 'Recording elapsed time');
        const pending = desktop.phase === 'starting' || desktop.phase === 'saving';
        const action =
          desktop.phase === 'starting'
            ? 'Preparing meeting'
            : desktop.phase === 'saving'
              ? 'Saving meeting'
              : desktop.phase === 'save-failed'
                ? 'Retry saving meeting'
                : 'Stop and save meeting';
        toggle.classList.toggle('is-recording', Boolean(desktop.recordingId));
        toggle.disabled = pending;
        toggle.setAttribute('aria-label', action);
        toggle.title = action;
        sessionBar.hidden = false;
        mark.hidden = true;
        feedback.textContent =
          desktop.phase === 'starting'
            ? 'Choose meeting audio in the sharing window.'
            : desktop.phase === 'saving'
              ? 'Saving meeting…'
              : desktop.phase === 'save-failed'
                ? 'Audio is waiting to be saved. Retry saving.'
                : 'Meeting audio + microphone';
        if (timer) timer.hidden = !desktop.recordingId;
        updateDesktopClock();
      } else if (timer) {
        timer.hidden = false;
        timer.setAttribute('aria-label', 'Elapsed recording time');
      }
      if (desktop?.phase === 'recording' && !desktopClock)
        desktopClock = setInterval(updateDesktopClock, 1000);
      else if (desktop?.phase !== 'recording' && desktopClock) {
        clearInterval(desktopClock);
        desktopClock = null;
      }
    }

    if (document.documentElement.dataset.synapCaptureUiBound !== '1') {
      document.documentElement.dataset.synapCaptureUiBound = '1';
      new MutationObserver(sync).observe(document.body, {
        attributes: true,
        attributeFilter: [
          'data-state',
          'data-startup',
          'data-recording-interrupted',
          'data-audio-delivery',
          'data-recording-finishing',
          'data-received-audio-clock',
        ],
      });
      new MutationObserver(sync).observe(connect, {
        attributes: true,
        attributeFilter: ['disabled'],
      });
      new MutationObserver(sync).observe(start, {
        attributes: true,
        attributeFilter: ['disabled'],
      });
      new MutationObserver(sync).observe(stop, { attributes: true, attributeFilter: ['disabled'] });
      for (const event of [
        'synap-desktop-capture-started',
        'synap-desktop-capture-stopped',
        'synap-desktop-capture-changed',
      ])
        window.addEventListener(event, sync);
    }
    sync();
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
