/* Account association, capture and selected-frame inference. Audio retains its existing owner. */
(function (root) {
  'use strict';
  const { Store, TARGET, windowFrames, explainWords, splitMJPEG } = root.SynapVisualStore;
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
  const controllers = new Set();
  let workController = null;
  const voicePending = new Set();
  let associatedConnection = null;
  const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
  const notify = () => root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
  const connected = () =>
    root.SynapModules?.client?.module?.id === 3 ? root.SynapDevices?.connection : null;
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
  function camera() {
    requireAccess();
    const next = connected();
    if (!next?.deviceId) throw Error('Connect your associated Chakshu first.');
    if (!devices.some((device) => device.deviceId === next.deviceId))
      throw Error('Associate this Chakshu with your account first.');
    if (root.SynapModules.client.module.mediaVersion !== 1)
      throw Error(
        'Update Chakshu firmware to enable camera transfers and paired video. SD files can still be imported.',
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
      clearTimeout(offlineTimer);
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
          ? 'Using saved account association. Cloud descriptions will retry when online.'
          : e.message;
    } finally {
      if (owner === expected) {
        accountPending = false;
        notify();
        if (
          ready() &&
          connected()?.deviceId &&
          root.SynapModules.client.module.mediaVersion === 1 &&
          !session &&
          !working
        )
          pollOffline();
      }
    }
  }
  async function operation(action) {
    if (working || session || offline) throw Error('Finish the current capture or transfer first.');
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
      const owned = requireAccess(),
        device = connected(),
        client = camera();
      let audio = root.SynapAppControls.recordingState();
      const audioOwned = withAudio && !audio.active;
      try {
        if (audioOwned) audio = await root.SynapAppControls.startMediaAudio();
        check(owned.owner);
        const atMs = audio.active ? audio.offsetMs : 0;
        const blob = await client.snapshot(signal);
        check(owned.owner);
        const row = await owned.store.create({
          kind: 'image',
          deviceId: device.deviceId,
          audioId: audio.active ? audio.recordingId : null,
          audioOffsetMs: atMs,
          name: 'Photo',
          captureMode: 'photo',
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
  async function describe(
    id,
    atMs = 0,
    prompt = 'Explain what is visible here.',
    scope = { owner, store },
  ) {
    check(scope.owner);
    requireAccess();
    const row = await scope.store.get(id);
    if (!row) throw Error('This visual is unavailable.');
    // Allow two following frames to arrive for an explicit live explanation.
    // A stopped take or a stalled radio uses only the frames actually retained.
    const deadline = Date.now() + 12000;
    let allFrames = await scope.store.frames(id);
    while (
      /^explain\b/i.test(prompt) &&
      session?.id === id &&
      !session.cancelled &&
      allFrames.filter((frame) => frame.atMs > atMs).length < 2 &&
      Date.now() < deadline
    ) {
      await delay(250);
      check(scope.owner);
      allFrames = await scope.store.frames(id);
    }
    const frames = windowFrames(allFrames, atMs);
    if (!frames.length) throw Error('No camera frame was saved close enough to this moment.');
    const input = [];
    for (const frame of frames) {
      const bytes = new Uint8Array(await frame.blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      input.push({ atMs: frame.atMs, jpeg: btoa(binary) });
    }
    const reply = await api(
      '/v1/chakshu/describe',
      { deviceId: row.deviceId, prompt, frames: input },
      scope.owner,
    );
    check(scope.owner);
    const current = await scope.store.get(id);
    if (!current) return;
    const description = {
      id: crypto.randomUUID(),
      atMs,
      prompt,
      text: reply.description,
      frameTimesMs: reply.frameTimesMs,
      createdAt: new Date().toISOString(),
    };
    await scope.store.addDescription(id, description);
    notify();
    return description;
  }
  async function saveAudio(sessionId) {
    if (!sessionId) return;
    await root.SynapAppControls.stopCapture(sessionId);
    // STOP acknowledgement schedules journal finalization in app.js. Wait for
    // that durable boundary before allowing startMediaAudio to choose a take.
    const deadline = Date.now() + 15000;
    while (root.SynapAppControls.recordingState().sessionId === sessionId) {
      if (Date.now() >= deadline)
        throw Error('Audio is still saving. Please wait before changing capture mode.');
      await delay(50);
    }
  }
  async function startLive(inference = true) {
    if (session || working || offline) throw Error('Finish the current capture first.');
    const owned = requireAccess(),
      client = camera(),
      deviceId = connected().deviceId;
    const take = {
      ...owned,
      controller: new AbortController(),
      cancelled: false,
      audioOwned: true,
      inference,
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
      const audio = await root.SynapAppControls.startMediaAudio();
      take.audioSession = audio.sessionId;
      take.audioId = audio.recordingId;
      check(take.owner);
      if (take.cancelled) throw Error('Video start cancelled.');
      const row = await take.store.create({
        kind: 'video',
        deviceId,
        audioId: audio.recordingId,
        name: 'Live video',
        captureMode: 'online',
        startedAt: audio.startedAt,
      });
      take.id = row.id;
      take.phase = 'recording';
      notify();
      take.task = (async () => {
        while (!take.cancelled) {
          const audio = root.SynapAppControls.recordingState();
          if (!audio.active || audio.recordingId !== take.audioId) break;
          const atMs = audio.offsetMs;
          const blob = await client.snapshot(take.controller.signal);
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
          // One inference at a time; slow networks cannot pile up model requests.
          if (take.inference && !take.analysis && Date.now() - (take.lastAnalysis || 0) >= 10000) {
            take.lastAnalysis = Date.now();
            take.analysis = describe(take.id, atMs, 'Briefly describe this current view.', take)
              .catch((e) => {
                if (owner === take.owner) {
                  error = e.message;
                  notify();
                }
              })
              .finally(() => {
                take.analysis = null;
              });
          }
          await delay(1500);
        }
      })()
        .catch((e) => {
          if (!take.cancelled && owner === take.owner) {
            error = e.message;
            notify();
          }
        })
        .finally(async () => {
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
  async function voiceCommand(command) {
    requireAccess();
    if (command === 1) return photo();
    if (command === 2) {
      if (!session && !offline) return startLive(false);
    } else if (command === 3) return stop();
    else if (command === 4) return setAudio(true);
    else if (command === 5) return setAudio(false);
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
  async function startOffline() {
    return operation(async () => {
      camera();
      if (root.SynapAppControls.recordingState().active)
        throw Error('Stop audio capture before recording to SD.');
      await transfer.request(5);
      offline = true;
      notify();
      pollOffline();
    });
  }
  let offlineTimer;
  async function pollOffline() {
    clearTimeout(offlineTimer);
    const expected = owner;
    try {
      const response = await camera().request(9);
      check(expected);
      const state = JSON.parse(new TextDecoder().decode(response.bytes));
      offline = state.active;
      if (state.error) error = 'SD recording failed. Keep the card and check partial files.';
      root.dispatchEvent(new CustomEvent('synap-chakshu-offline', { detail: state }));
      notify();
    } catch (e) {
      if (owner !== expected) return;
      if (offline)
        error = 'SD recording continues on Chakshu, up to 60 seconds. Reconnect to check it.';
      notify();
    }
    if (offline && connected()) offlineTimer = setTimeout(pollOffline, 2000);
  }
  async function catalogue() {
    return operation(async (signal) => {
      const files = await camera().catalogue(signal);
      if (!Array.isArray(files)) throw Error('Invalid SD catalogue.');
      return files;
    });
  }
  async function importAudio(blob, deviceId, scope, onBegin) {
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
    const id = await journal.begin('Chakshu audio', { deviceId });
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
        new CustomEvent('synap-desktop-capture-saved', { detail: { recordingId: id } }),
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
        captureMode: 'offline',
        timingEstimated: !image && !timing,
        sourceName: file.name,
      });
      try {
        for (const frame of frames) {
          check(scope.owner);
          await scope.store.append(row.id, frame);
        }
        if (audioFile)
          await importAudio(audioFile, deviceId, scope, (audioId) =>
            scope.store.patch(row.id, { audioId }),
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
        files.some((f) => f.name === file.name.replace(/\.wav$/i, '.mjpeg'))
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
  async function transcribed(event) {
    const detail = event.detail;
    if (!ready() || detail.ownerUid !== owner) return;
    const scope = { owner, store },
      rows = (await store.list()).filter(
        (row) => row.kind === 'video' && row.audioId === detail.recordingId,
      );
    for (const row of rows)
      for (const atMs of explainWords(detail.words)) {
        if (row.timingEstimated) continue;
        const key = 'voice:' + atMs;
        const pendingKey = scope.owner + ':' + row.id + ':' + key;
        const current = await scope.store.get(row.id);
        if (current?.voiceRequests?.includes(key) || voicePending.has(pendingKey)) continue;
        const frames = windowFrames(await scope.store.frames(row.id), atMs);
        if (!frames.length) continue;
        if (voicePending.has(pendingKey)) continue;
        voicePending.add(pendingKey);
        try {
          await describe(row.id, atMs, 'Explain what is visible around this moment.', scope);
          await scope.store.ackVoiceRequest(row.id, key);
        } catch (e) {
          if (owner === scope.owner) {
            error = e.message;
            notify();
          }
        } finally {
          voicePending.delete(pendingKey);
        }
      }
  }
  const apiObject = {
    sync,
    photo,
    startLive,
    setAudio,
    voiceCommand,
    startOffline,
    stop,
    describe,
    catalogue,
    importSD,
    importFiles: (files, deviceId) => operation(() => importFilesNow(files, deviceId)),
    pollOffline,
    get state() {
      return {
        owner,
        available: ready(),
        connected: Boolean(connected()),
        cameraReady: root.SynapModules?.client?.module?.mediaVersion === 1,
        devices,
        error,
        working,
        offline,
        session: session ? { id: session.id, phase: session.phase } : null,
      };
    },
    get store() {
      return store;
    },
    get busy() {
      return working || offline || Boolean(session);
    },
  };
  root.SynapChakshu = apiObject;
  root.addEventListener('synap-audio-transcribed', (e) =>
    transcribed(e).catch((error) => {
      if (error.name !== 'AbortError') console.warn('Chakshu explanation deferred', error.message);
    }),
  );
  root.addEventListener('synap-device-identified', sync);
  root.addEventListener('synap-module-changed', () => {
    const next = connected();
    if (
      next?.deviceId &&
      (next !== associatedConnection || !devices.some((d) => d.deviceId === next.deviceId))
    ) {
      associatedConnection = next;
      sync();
    }
    notify();
  });
  root.addEventListener('synap-gatt-disconnected', () => {
    context = null;
    transfer = null;
    session?.controller.abort();
    notify();
  });
  root.addEventListener('online', sync);
  root.SynapAuth?.onChange(sync);
  sync();
})(globalThis);
