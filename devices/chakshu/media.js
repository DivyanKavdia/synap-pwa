/* Local camera capture on phone or SD. Standalone audio keeps its transcription flow. */
(function (root) {
  'use strict';
  const { Store, TARGET, splitMJPEG } = root.SynapVisualStore;
  const capabilities = root.SynapCapabilities;
  const moduleInfo = () => root.SynapModules?.client?.module;
  const CACHE = 'synap-account-chakshu-v1:';
  const uid = () => String(root.SynapAuth?.session?.()?.profile?.uid || '');
  const delay = (ms) => new Promise((resolve) => root.setTimeout(resolve, ms));
  let owner = '',
    store = null,
    devices = [],
    error = '',
    session = null,
    working = false,
    offline = false,
    transfer = null,
    context = null,
    accountPending = false;
  let transferProgress = null,
    sdFiles = [],
    sdFilesDeviceId = '';
  let offlineStatus = null,
    wifi = null,
    wifiTimer,
    wifiPoll = null;
  const controllers = new Set();
  let workController = null;
  let associatedConnection = null;
  const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
  const notify = () => root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
  const connectionStatus = () =>
    capabilities.cameraConnection(root.SynapDevices?.connection, root.SynapModules?.client);
  const connected = () =>
    connectionStatus().state === 'connected' ? root.SynapDevices.connection : null;
  async function prepareCamera() {
    const physical = root.SynapDevices?.connection,
      expected = owner;
    if (physical && !connected()) await root.SynapModules?.refresh();
    check(expected);
    if (physical !== root.SynapDevices?.connection)
      throw Error('Pendant connection changed. Retry capture.');
    if (!connected()) throw Error(connectionStatus().message);
  }
  const ready = () => Boolean(owner && devices.some((device) => device.target === TARGET));
  function check(expected) {
    if (!expected || uid() !== expected || owner !== expected)
      throw Error('Account changed. Return to the capture owner to continue.');
  }
  async function api(path, body, expected = owner, method = 'POST') {
    check(expected);
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await root.SynapAuth.authedFetch(path, {
        method,
        expectedUid: expected,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      check(expected);
      const data = await response.json();
      check(expected);
      if (!response.ok) throw Error(data.error?.message || 'Chakshu request failed.');
      return data;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  function requireAccess() {
    check(owner);
    if (!ready())
      throw Error('Photo/video library unavailable. Associate Chakshu with this account first.');
    return { owner, store };
  }
  function camera(kind, offlineCapture = false) {
    requireAccess();
    const next = connected();
    if (!next?.deviceId) throw Error(connectionStatus().message);
    if (!devices.some((device) => device.deviceId === next.deviceId))
      throw Error('Associate this Chakshu with your account first.');
    if (!capabilities.hasMedia(moduleInfo()))
      throw Error(
        'Update Chakshu firmware to enable camera transfers and paired video. SD files can still be imported.',
      );
    if (kind && !capabilities.canCapture(moduleInfo(), kind, offlineCapture))
      throw Error(
        offlineCapture
          ? 'Camera, microphone or SD card unavailable. Check hardware before recording offline.'
          : kind === 'video'
            ? 'Camera or microphone unavailable. Refresh hardware status and retry.'
            : 'Camera unavailable. Refresh hardware status and retry.',
      );
    if (context !== next) {
      context = next;
      transfer = new root.SynapChakshuTransfer.Client(next);
    }
    return transfer;
  }
  function saveCache() {
    localStorage.setItem(CACHE + owner, JSON.stringify(devices));
  }
  async function sync() {
    const next = uid();
    if (next !== owner) {
      controllers.forEach((controller) => controller.abort());
      workController?.abort();
      const old = session;
      if (old) {
        old.cancelled = true;
        old.controller.abort();
        if (old.audioOwned && old.audioSession)
          root.SynapAppControls.stopCapture(old.audioSession).catch(() => {});
      }
      session = null;
      offline = false;
      offlineStatus = null;
      wifi = null;
      sdFiles = [];
      sdFilesDeviceId = '';
      clearTimeout(wifiTimer);
      clearTimeout(offlineTimer);
      clearTimeout(autoSyncTimer);
      owner = next;
      devices = [];
      store = next ? new Store(next) : null;
      error = '';
      accountPending = false;
      if (next) {
        try {
          devices = JSON.parse(localStorage.getItem(CACHE + next) || '[]').filter(
            (d) => d.target === TARGET,
          );
        } catch (_) {
          devices = [];
        }
        const ownStore = store;
        ownStore.recover().catch((e) => {
          if (store === ownStore) {
            error = e.message;
            notify();
          }
        });
      }
      notify();
    }
    if (!owner || accountPending) return;
    accountPending = true;
    const expected = owner;
    try {
      const result = await api('/v1/devices', null, expected, 'GET');
      devices = (result.devices || []).filter((device) => device.target === TARGET);
      saveCache();
      error = '';
      const device = connected();
      if (device?.deviceId && !devices.some((d) => d.deviceId === device.deviceId)) {
        const result = await api(
          '/v1/devices/chakshu',
          { deviceId: device.deviceId, target: TARGET },
          expected,
          'PUT',
        );
        devices.push(result.device);
        saveCache();
      }
    } catch (e) {
      if (owner === expected)
        error = ready()
          ? 'Using the saved account association. Photos and videos stay on this phone.'
          : e.message;
    } finally {
      if (owner === expected) {
        accountPending = false;
        notify();
        if (
          ready() &&
          connected()?.deviceId &&
          capabilities.hasMedia(moduleInfo()) &&
          !session &&
          !working
        )
          pollOffline();
      }
    }
  }
  async function operation(action) {
    if (working || session || offline || wifi?.active)
      throw Error('Finish the current capture or download session first.');
    working = true;
    const controller = new AbortController(),
      expected = owner;
    workController = controller;
    error = '';
    notify();
    try {
      return await action(controller.signal);
    } catch (e) {
      if (owner === expected) error = e.message;
      throw e;
    } finally {
      working = false;
      if (workController === controller) workController = null;
      notify();
    }
  }
  async function snapshot(client, signal, preview = false) {
    const expected = owner;
    let lastProgressAt = 0;
    transferProgress = { percent: 0, totalBytes: 0, receivedBytes: 0 };
    notify();
    try {
      return await client.snapshot(
        signal,
        (fraction, totalBytes) => {
          if (expected !== owner || signal?.aborted) return;
          transferProgress = {
            percent: Math.floor(fraction * 100),
            totalBytes,
            receivedBytes: Math.round(fraction * totalBytes),
          };
          if (fraction === 1 || Date.now() - lastProgressAt >= 200) {
            lastProgressAt = Date.now();
            notify();
          }
        },
        preview,
      );
    } finally {
      if (expected === owner) {
        transferProgress = null;
        notify();
      }
    }
  }
  async function photo(withAudio = false) {
    if (session?.id && session.phase === 'recording') {
      const take = session,
        frame = await take.store.lastFrame(take.id);
      check(take.owner);
      if (!frame) throw Error('Wait for the first video frame.');
      const row = await take.store.create({
        kind: 'image',
        name: 'Video photo',
        deviceId: connected()?.deviceId,
        audioId: take.audioId,
        audioOffsetMs: frame.atMs,
        captureMode: 'video-frame',
      });
      await take.store.append(row.id, { blob: frame.blob, atMs: frame.atMs });
      await take.store.patch(row.id, { state: 'saved' });
      notify();
      return row.id;
    }
    return operation(async (signal) => {
      await prepareCamera();
      const owned = requireAccess(),
        device = connected(),
        client = camera('photo');
      let audio = root.SynapAppControls.recordingState();
      const audioOwned = withAudio;
      try {
        if (audioOwned) {
          if (audio.active) await saveAudio(audio.sessionId);
          audio = await root.SynapAppControls.startMediaAudio({ localOnly: true });
        }
        check(owned.owner);
        const atMs = audio.active ? audio.offsetMs : 0;
        const blob = await snapshot(client, signal);
        check(owned.owner);
        const row = await owned.store.create({
          kind: 'image',
          deviceId: device.deviceId,
          audioId: audio.active ? audio.recordingId : null,
          audioOffsetMs: atMs,
          name: 'Photo',
          captureMode: 'photo',
          localOnly: true,
        });
        await owned.store.append(row.id, { blob, atMs });
        await owned.store.patch(row.id, { state: 'saved' });
        notify();
        return row.id;
      } catch (e) {
        if (audioOwned && audio.sessionId)
          await root.SynapAppControls.stopCapture(audio.sessionId).catch(() => {});
        throw e;
      }
    });
  }
  // Old cached callers cannot opt back into cloud visual processing.
  async function describe() {
    throw Error('Photos and videos stay on this phone. Cloud descriptions are disabled.');
  }
  async function saveAudio(sessionId) {
    if (!sessionId) return;
    await root.SynapAppControls.stopCapture(sessionId);
    // STOP acknowledgement schedules journal finalization in app.js. Wait for
    // that durable boundary before allowing startMediaAudio to choose a take.
    const deadline = Date.now() + 15000;
    while (true) {
      const audio = root.SynapAppControls.recordingState();
      // The journal can clear its ID while the capture owner is still releasing
      // resources and refreshing saved recordings. Wait for that transition too.
      if (audio.sessionId !== sessionId && !audio.settling) break;
      if (Date.now() >= deadline)
        throw Error('Audio is still saving. Please wait before changing capture mode.');
      await delay(50);
    }
  }
  async function startLive() {
    if (session || working || offline || wifi?.active)
      throw Error('Finish the current capture or download session first.');
    await prepareCamera();
    if (session || working || offline || wifi?.active)
      throw Error('Finish the current capture or download session first.');
    const owned = requireAccess(),
      client = camera('video'),
      deviceId = connected().deviceId;
    const take = {
      ...owned,
      controller: new AbortController(),
      cancelled: false,
      audioOwned: true,
      bytes: 0,
      phase: 'starting',
    };
    session = take;
    take.startDone = new Promise((resolve) => {
      take.finishStart = resolve;
    });
    error = '';
    notify();
    try {
      // A video soundtrack owns a new journal, never an earlier audio-only take.
      const previous = root.SynapAppControls.recordingState();
      if (previous.active) await saveAudio(previous.sessionId);
      check(take.owner);
      if (take.cancelled) throw Error('Video start cancelled.');
      const audio = await root.SynapAppControls.startMediaAudio({ localOnly: true });
      take.audioSession = audio.sessionId;
      take.audioId = audio.recordingId;
      check(take.owner);
      if (take.cancelled) throw Error('Video start cancelled.');
      const row = await take.store.create({
        kind: 'video',
        deviceId,
        audioId: audio.recordingId,
        name: 'Live video',
        captureMode: 'phone',
        localOnly: true,
        startedAt: audio.startedAt,
      });
      take.id = row.id;
      take.phase = 'recording';
      notify();
      take.task = (async () => {
        while (!take.cancelled) {
          const audio = root.SynapAppControls.recordingState();
          if (!audio.active || audio.recordingId !== take.audioId) break;
          if (audio.phase === 'interrupted') {
            await delay(300);
            continue;
          }
          const frameStarted = Date.now();
          const atMs = audio.offsetMs;
          const blob = await snapshot(client, take.controller.signal, true);
          check(take.owner);
          if (take.cancelled) break;
          if (take.bytes + blob.size > MAX_VIDEO_BYTES) {
            take.cancelled = true;
            error = 'Video saved at the 32 MiB clip limit. Start another take to continue.';
            break;
          }
          await take.store.append(take.id, { blob, atMs });
          take.bytes += blob.size;
          notify();
          // Capture/transfer time counts toward cadence. Yield more airtime
          // when the audio clock falls behind; never build a frame request queue.
          const current = root.SynapAppControls.recordingState();
          const cadence = current.phase === 'interrupted' ? 1500 : 400;
          await delay(Math.max(40, cadence - (Date.now() - frameStarted)));
        }
      })()
        .catch((e) => {
          if (!take.cancelled && owner === take.owner) {
            error = e.message;
            notify();
          }
        })
        .finally(async () => {
          take.phase = 'saving';
          notify();
          if (take.audioOwned)
            await saveAudio(take.audioSession).catch((e) => {
              if (owner === take.owner) error = e.message;
            });
          await take.store
            .patch(take.id, { state: take.cancelled ? 'saved' : 'interrupted' })
            .catch((e) => {
              if (owner === take.owner) error = e.message;
            });
          if (session === take) session = null;
          notify();
        });
    } catch (e) {
      take.cancelled = true;
      try {
        if (take.audioOwned && take.audioSession) await saveAudio(take.audioSession);
      } finally {
        if (session === take) session = null;
        error = e.message;
        notify();
      }
      throw e;
    } finally {
      take.finishStart();
    }
  }
  async function setAudio(on) {
    const scope = requireAccess();
    if (working) throw Error('Finish the current capture or transfer first.');
    working = true;
    notify();
    try {
      if (session || offline) await stop();
      check(scope.owner);
      const audio = root.SynapAppControls.recordingState();
      if (on) return await root.SynapAppControls.startMediaAudio();
      if (audio.active) return await saveAudio(audio.sessionId);
    } finally {
      working = false;
      notify();
    }
  }
  async function stop() {
    const take = session;
    if (take) {
      take.cancelled = true;
      take.controller.abort();
      take.phase = 'saving';
      notify();
      await take.startDone;
      await take.task;
    } else if (offline) {
      const expected = owner;
      await camera().request(6);
      const deadline = Date.now() + 15000;
      do {
        check(expected);
        await pollOffline();
        if (!offline) break;
        if (!connected() || Date.now() >= deadline)
          throw Error('Chakshu is still saving to SD. Reconnect and check the recording.');
        await delay(300);
      } while (offline);
    }
  }
  async function startOffline(profile = 0, seconds = 30) {
    if (![0, 1].includes(profile) || ![15, 30, 60].includes(seconds))
      throw Error('Choose an available SD quality and clip length.');
    return operation(async (signal) => {
      const expected = owner;
      await prepareCamera();
      if (!(moduleInfo()?.mediaFeatures & 16))
        throw Error('Update Chakshu firmware for SD video quality controls.');
      const client = camera('video', true);
      const audio = root.SynapAppControls.recordingState();
      if (audio.active) await saveAudio(audio.sessionId);
      check(expected);
      await client.request(5, profile | (seconds << 8), '', signal);
      check(expected);
      offline = true;
      offlineStatus = {
        active: true,
        audioMs: 0,
        frames: 0,
        clipLimitMs: seconds * 1000,
        width: profile === 0 ? 1280 : 640,
        height: profile === 0 ? 720 : 480,
        targetFps: profile === 0 ? 10 : 20,
        videoProfile: profile,
      };
      notify();
      await pollOffline();
    });
  }
  async function startVideo() {
    return startLive();
  }
  async function refreshSD() {
    if (root.SynapAppControls.recordingState().active)
      throw Error('Stop recording before checking the SD card.');
    try {
      if (moduleInfo()?.mediaFeatures & 8)
        await operation(async (signal) => camera().request(14, 0, '', signal));
      else await root.SynapModules.run(1);
    } finally {
      await root.SynapModules?.refresh();
    }
  }
  function decodeWifi(reply) {
    const next = JSON.parse(new TextDecoder().decode(reply.bytes));
    if (next.active !== true) return null;
    if (
      !/^Chakshu-[A-F0-9]{4}$/.test(next.ssid) ||
      !/^[a-f0-9]{32}$/.test(next.password) ||
      !/^http:\/\/192\.168\.4\.1\/\?key=[a-f0-9]{32}$/.test(next.url)
    )
      throw Error('The private download network could not be verified.');
    return next;
  }
  async function pollWifi() {
    if (wifiPoll) return wifiPoll;
    wifiPoll = refreshWifi().finally(() => {
      wifiPoll = null;
    });
    return wifiPoll;
  }
  async function refreshWifi() {
    clearTimeout(wifiTimer);
    const expected = owner;
    const deviceId = connected()?.deviceId;
    try {
      if (wifi?.deviceId && deviceId !== wifi.deviceId) return;
      const next = decodeWifi(await camera().request(21));
      check(expected);
      if (connected()?.deviceId !== deviceId) return;
      wifi = next ? { ...next, deviceId } : null;
    } catch (_) {
      /* Keep the join details while the phone changes networks. */
    }
    if (expected !== owner) return;
    notify();
    if (wifi?.active && connected()) wifiTimer = setTimeout(pollWifi, 5000);
  }
  async function startWifi() {
    if (root.SynapAppControls.recordingState().active)
      throw Error('Stop recording before starting Wi-Fi downloads.');
    if (!(moduleInfo()?.mediaFeatures & 4))
      throw Error('Update Chakshu firmware for Wi-Fi downloads.');
    return operation(async (signal) => {
      if (!capabilities.ready(moduleInfo(), 'sd'))
        throw Error('Insert an SD card, then choose Check SD card.');
      const expected = owner;
      // Recover a session whose start reply was interrupted without creating a
      // second network or leaving the card locked behind a repeated start.
      const existing = decodeWifi(await camera().request(21, 0, '', signal));
      const next = existing || decodeWifi(await camera().request(20, 0, '', signal));
      check(expected);
      wifi = next ? { ...next, deviceId: connected()?.deviceId } : null;
      if (!wifi) throw Error('Wi-Fi downloads did not start.');
      notify();
      wifiTimer = setTimeout(pollWifi, 5000);
    });
  }
  async function stopWifi() {
    if (!wifi?.active) return;
    const expected = owner;
    await camera().request(22);
    check(expected);
    // The firmware closes any current download before releasing the SD lease.
    const deadline = Date.now() + 12000;
    do {
      await delay(200);
      await pollWifi();
      check(expected);
      if (!wifi?.active) return;
    } while (Date.now() < deadline);
    throw Error('Finishing the current download. Use Finish downloads on Chakshu’s download page.');
  }
  let offlineTimer, autoSyncTimer, autoSyncPromise;
  function schedulePendingSync(delayMs = 1200) {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
    if (!owner || !connected() || !ready()) return;
    autoSyncTimer = setTimeout(() => {
      autoSyncTimer = null;
      syncPendingSD().catch((e) => {
        if (owner) {
          error = e.message;
          notify();
        }
      });
    }, delayMs);
  }
  async function pollOffline() {
    clearTimeout(offlineTimer);
    const expected = owner;
    try {
      const response = await camera().request(9);
      check(expected);
      const state = JSON.parse(new TextDecoder().decode(response.bytes)),
        wasOffline = offline;
      offline = state.active;
      offlineStatus = state;
      if (state.error)
        error =
          state.error === 9
            ? 'The SD card could not keep up. The partial recording was kept.'
            : 'SD recording failed. Keep the card and check partial files.';
      root.dispatchEvent(new CustomEvent('synap-chakshu-offline', { detail: state }));
      notify();
    } catch (e) {
      if (owner !== expected) return;
      if (offline)
        error =
          'SD recording may still be running on Chakshu. It stops at the selected clip limit. Reconnect to check it.';
      notify();
    }
    if (offline && connected()) offlineTimer = setTimeout(pollOffline, 2000);
    else if (connected()) schedulePendingSync(300);
  }
  function rememberCatalogue(files, deviceId) {
    if (!Array.isArray(files)) throw Error('Invalid SD catalogue.');
    const previous = new Map(sdFiles.map((file) => [file.path, file])),
      next = files.flatMap((file) => {
        const path = String(file?.path || ''), bytes = Number(file?.bytes);
        if (!/^\/synap\/[a-f0-9]{8}-[a-f0-9]{8}\.(jpg|wav|mjpeg)$/i.test(path) || !Number.isSafeInteger(bytes) || bytes < 0) return [];
        return [{ path, bytes, seenAt: previous.get(path)?.seenAt || new Date().toISOString() }];
      }),
      before = JSON.stringify([sdFilesDeviceId, sdFiles.map((file) => [file.path, file.bytes])]),
      after = JSON.stringify([deviceId || '', next.map((file) => [file.path, file.bytes])]);
    sdFiles = next;
    sdFilesDeviceId = deviceId || '';
    if (before !== after) {
      notify();
      root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
    }
    return sdFiles.slice();
  }
  function forgetSDPath(path) {
    const before = sdFiles.length;
    sdFiles = sdFiles.filter((file) => file.path !== path);
    if (sdFiles.length !== before) {
      notify();
      root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
    }
  }
  async function catalogue() {
    return operation(async (signal) => {
      const deviceId = connected()?.deviceId || '', files = await camera().catalogue(signal);
      return rememberCatalogue(files, deviceId);
    });
  }
  async function importAudio(blob, deviceId, scope, onBegin, localOnly = false) {
    const bytes = new Uint8Array(await blob.arrayBuffer()),
      view = new DataView(bytes.buffer);
    const text = (at, n) => new TextDecoder().decode(bytes.subarray(at, at + n));
    if (
      bytes.length < 44 ||
      text(0, 4) !== 'RIFF' ||
      text(8, 4) !== 'WAVE' ||
      text(12, 4) !== 'fmt ' ||
      view.getUint16(20, true) !== 1 ||
      view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== 16000 ||
      view.getUint16(34, true) !== 16 ||
      text(36, 4) !== 'data' ||
      view.getUint32(40, true) !== bytes.length - 44
    )
      throw Error('Use Chakshu’s complete mono 16 kHz PCM WAV file.');
    check(scope.owner);
    const journal = new root.DKAudioStore({
      ...root.SynapRecordingJournal.options(),
      metadata: () => ({
        ownerUid: scope.owner,
        rollingTranscription: true,
        transcriptionWindowSeconds: 30,
        uploadAudioProcessing: 'none',
      }),
    });
    const id = await journal.begin(
      localOnly ? 'Video soundtrack' : 'Chakshu audio',
      { deviceId },
      { localOnly },
    );
    try {
      // Attach the visual before any sealed audio window can trigger transcription.
      await onBegin(id);
      for (let at = 44, sequence = 0; at < bytes.length; at += 1600) {
        check(scope.owner);
        const payload = new Uint8Array(1600);
        payload.set(bytes.subarray(at, Math.min(at + 1600, bytes.length)));
        journal.append(id, { sequence: sequence++, chunk: 0, total: 1, payload });
        if (sequence % 100 === 0) await journal.flush();
      }
      await journal.close(id);
      root.dispatchEvent(
        new CustomEvent('synap-recording-saved', {
          detail: { recordingId: id, source: 'chakshu-import' },
        }),
      );
      return id;
    } catch (e) {
      await journal.close(id, 'import-interrupted').catch(() => {});
      throw e;
    }
  }
  async function importFilesNow(files, deviceId = devices[0]?.deviceId) {
    const scope = requireAccess();
    let count = 0;
    for (const file of files) {
      if (!/\.(jpg|jpeg|mjpeg)$/i.test(file.name)) continue;
      check(scope.owner);
      if (file.size > MAX_VIDEO_BYTES) throw Error('Import camera files up to 32 MiB each.');
      const image = /\.jpe?g$/i.test(file.name),
        stem = file.name.replace(/\.[^.]+$/, ''),
        timingFile = files.find((f) => f.name === stem + '.json');
      const timing = timingFile ? JSON.parse(await timingFile.text()) : null;
      if (
        timing &&
        (!Array.isArray(timing.frameTimesMs) ||
          timing.frameTimesMs.some(
            (t, i, a) => !Number.isFinite(t) || t < 0 || (i && t < a[i - 1]),
          ))
      )
        throw Error('Invalid video frame timeline.');
      const frames = splitMJPEG(new Uint8Array(await file.arrayBuffer()), timing?.frameTimesMs);
      if (
        timing &&
        (timing.frameTimesMs.length !== frames.length ||
          !Number.isFinite(timing.durationMs) ||
          timing.durationMs < frames.at(-1).atMs)
      )
        throw Error('The video and frame timeline do not match.');
      const audioFile = files.find((f) => f.name === stem + '.wav');
      if (audioFile?.size > MAX_VIDEO_BYTES) throw Error('Import audio files up to 32 MiB each.');
      const row = await scope.store.create({
        kind: image ? 'image' : 'video',
        deviceId,
        name: file.name,
        audioId: null,
        captureMode: 'import',
        localOnly: true,
        timingEstimated: !image && !timing,
        sourceName: file.name,
        ...(!image &&
        timing &&
        Number.isInteger(timing.width) &&
        timing.width > 0 &&
        timing.width <= 2048 &&
        Number.isInteger(timing.height) &&
        timing.height > 0 &&
        timing.height <= 1536
          ? {
              sdCapture: {
                width: timing.width,
                height: timing.height,
                audioMs: timing.durationMs,
                frames: frames.length,
                droppedFrames:
                  Number.isSafeInteger(timing.droppedFrames) && timing.droppedFrames >= 0
                    ? timing.droppedFrames
                    : 0,
              },
            }
          : {}),
      });
      try {
        for (const frame of frames) {
          check(scope.owner);
          await scope.store.append(row.id, frame);
        }
        if (audioFile)
          await importAudio(
            audioFile,
            deviceId,
            scope,
            (audioId) => scope.store.patch(row.id, { audioId }),
            true,
          );
        await scope.store.patch(row.id, {
          state: 'saved',
          durationMs: timing?.durationMs || frames.at(-1).atMs,
        });
      } catch (e) {
        await scope.store.patch(row.id, { state: 'interrupted' });
        throw e;
      }
      count++;
    }
    for (const file of files) {
      if (
        !/\.wav$/i.test(file.name) ||
        files.some(
          (f) =>
            /\.(mjpeg|jpe?g)$/i.test(f.name) &&
            f.name.replace(/\.[^.]+$/, '') === file.name.replace(/\.wav$/i, ''),
        )
      )
        continue;
      if (file.size > MAX_VIDEO_BYTES) throw Error('Import audio files up to 32 MiB each.');
      await importAudio(file, deviceId, scope, async () => {});
      count++;
    }
    if (!count)
      throw Error('Select a JPEG photo or MJPEG video, with its matching WAV and JSON files.');
    notify();
    return count;
  }
  async function importSD(path, progress) {
    return operation(async (signal) => {
      const scope = requireAccess(),
        client = camera(),
        files = [];
      const deviceId = connected().deviceId;
      const add = async (name) => {
        const blob = await client.file(name, signal, progress);
        files.push(new File([blob], name.split('/').pop()));
      };
      await add(path);
      check(scope.owner);
      if (path.endsWith('.mjpeg')) {
        for (const extension of ['json', 'wav']) {
          try {
            await add(path.replace(/mjpeg$/, extension));
          } catch (e) {
            if (!/SD file unavailable/.test(e.message)) throw e;
          }
        }
      }
      check(scope.owner);
      return importFilesNow(files, deviceId);
    });
  }
  async function removeSyncedPath(path, optional = false) {
    try {
      await camera().request(17, 0, path);
      return true;
    } catch (e) {
      if (optional) return false;
      throw e;
    }
  }
  async function deleteSyncedSet(path) {
    // Delete companions first so a failed final delete cannot expose a video WAV as a new audio item.
    if (/\.mjpeg$/i.test(path)) {
      await removeSyncedPath(path.replace(/mjpeg$/i, 'json'), true);
      await removeSyncedPath(path.replace(/mjpeg$/i, 'wav'), true);
    }
    await removeSyncedPath(path);
    forgetSDPath(path);
  }
  async function moveSD(path, progress) {
    const scope = requireAccess(), expected = scope.owner, deviceId = connected()?.deviceId;
    if (!deviceId) throw Error('Connect Chakshu before moving an SD capture.');
    if (!/^\/synap\/[a-f0-9]{8}-[a-f0-9]{8}\.(jpg|mjpeg)$/i.test(path)) throw Error('Only Chakshu photos and videos can be moved into this library.');
    const sourceName = path.split('/').pop(), imported = async () => (await scope.store.list()).some((row) => row.deviceId === deviceId && row.sourceName === sourceName && row.state === 'saved');
    if (!(await imported())) await importSD(path, progress);
    check(expected);
    if (connected()?.deviceId !== deviceId) throw Error('Chakshu connection changed before the SD original could be cleared.');
    if (!(await imported())) throw Error('The capture was not verified in the app. The SD original was kept.');
    await deleteSyncedSet(path);
    root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
    return sourceName;
  }
  async function syncPendingSD() {
    if (autoSyncPromise) return autoSyncPromise;
    if (!owner || !connected() || !ready() || working || session || offline || wifi?.active) return 0;
    const expected = owner,
      device = connected(),
      deviceId = device?.deviceId;
    if (!deviceId) return 0;
    autoSyncPromise = (async () => {
      const files = await catalogue();
      let count = 0;
      for (const file of files) {
        check(expected);
        if (
          connected()?.deviceId !== deviceId ||
          working ||
          session ||
          offline ||
          wifi?.active
        )
          break;
        const sourceName = file.path.split('/').pop(),
          rows = await store.list(),
          alreadyImported = rows.some(
            (row) =>
              row.deviceId === deviceId &&
              row.sourceName === sourceName &&
              row.state === 'saved',
          );
        if (!alreadyImported) await importSD(file.path);
        check(expected);
        if (connected()?.deviceId !== deviceId) break;
        await deleteSyncedSet(file.path);
        count++;
      }
      if (count) root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
      return count;
    })().finally(() => {
      autoSyncPromise = null;
    });
    return autoSyncPromise;
  }
  const apiObject = {
    sync,
    photo,
    startLive,
    startVideo,
    setAudio,
    startOffline,
    refreshSD,
    startWifi,
    stopWifi,
    stop,
    describe,
    catalogue,
    importSD,
    moveSD,
    syncPendingSD,
    importFiles: (files, deviceId) => operation(() => importFilesNow(files, deviceId)),
    pollOffline,
    get state() {
      return {
        transferProgress,
        owner,
        available: ready(),
        connected: Boolean(connected()),
        connectionStatus: connectionStatus(),
        cameraReady: capabilities.canCapture(moduleInfo(), 'photo'),
        videoReady: capabilities.canCapture(moduleInfo(), 'video'),
        offlineReady:
          Boolean(moduleInfo()?.mediaFeatures & 16) &&
          capabilities.canCapture(moduleInfo(), 'video', true),
        sdProfilesSupported: Boolean(moduleInfo()?.mediaFeatures & 16),
        storageReady: capabilities.hasMedia(moduleInfo()) && capabilities.ready(moduleInfo(), 'sd'),
        sdFiles: sdFiles.slice(),
        sdFilesDeviceId,
        mediaSupported: capabilities.hasMedia(moduleInfo()),
        voiceSupported: false,
        devices,
        error,
        working,
        offline,
        offlineStatus,
        wifi,
        wifiSupported: Boolean(moduleInfo()?.mediaFeatures & 4),
        sdVideoPreferred: false,
        session: session ? { id: session.id, phase: session.phase } : null,
      };
    },
    get store() {
      return store;
    },
    get busy() {
      return working || offline || Boolean(session) || Boolean(wifi?.active);
    },
  };
  root.SynapChakshu = apiObject;
  root.addEventListener('synap-device-identified', sync);
  root.addEventListener('synap-module-changed', () => {
    const next = connected();
    const deviceId = root.SynapDevices?.connection?.deviceId;
    if (sdFilesDeviceId && deviceId && sdFilesDeviceId !== deviceId) {
      sdFiles = [];
      sdFilesDeviceId = '';
      root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
    }
    if (wifi?.deviceId && deviceId && wifi.deviceId !== deviceId) {
      wifi = null;
      clearTimeout(wifiTimer);
    }
    if (
      next?.deviceId &&
      (next !== associatedConnection || !devices.some((d) => d.deviceId === next.deviceId))
    ) {
      associatedConnection = next;
      sync();
    }
    if (next && wifi?.active && !working) pollWifi();
    if (next && !wifi?.active) schedulePendingSync(1200);
    notify();
  });
  root.addEventListener('synap-gatt-disconnected', () => {
    context = null;
    transfer = null;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
    session?.controller.abort();
    notify();
  });
  root.addEventListener('synap-chakshu-media-pending', () => {
    pollOffline();
    schedulePendingSync(1200);
  });
  root.addEventListener('online', sync);
  root.SynapAuth?.onChange(sync);
  sync();
})(globalThis);
