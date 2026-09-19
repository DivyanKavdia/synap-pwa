/* Device-side commands use an explicit short foreground lease and the app's media queue. */
(function (root) {
  'use strict';
  const CONTROL = '4fa12356-0000-1000-8000-00805f9b34fb',
    EVENTS = '4fa12357-0000-1000-8000-00805f9b34fb',
    DIAGNOSTICS = '4fa12358-0000-1000-8000-00805f9b34fb',
    PROTOCOL = 2,
    WAKE = 1,
    PHOTO = 2,
    VIDEO_START = 3,
    VIDEO_STOP = 4,
    AUDIO_ON = 5,
    AUDIO_OFF = 6,
    DESCRIBE = 7,
    STOP = 8;
  let binding = null,
    pending = false,
    timer = null,
    lastPoll = 0,
    message = '',
    state = null,
    diagnostic = null,
    feedbackTimer = null;
  const api = () => root.SynapChakshu;
  const supported = () => root.SynapCapabilities?.hasVoice(root.SynapModules?.client?.module);
  function validCommand(command) {
    return command === 0 || command === WAKE || (command >= PHOTO && command <= STOP);
  }
  function decode(value) {
    if (
      value?.byteLength !== 22 ||
      value.getUint8(0) !== 0xcd ||
      value.getUint8(1) !== PROTOCOL ||
      value.getUint8(2) > 5 ||
      !validCommand(value.getUint8(8)) ||
      value.getUint8(9) > 3
    )
      throw Error('Unsupported Chakshu voice status.');
    return Object.freeze({
      status: value.getUint8(2),
      enabled: Boolean(value.getUint8(3)),
      sequence: value.getUint32(4, true),
      command: value.getUint8(8),
      result: value.getUint8(9),
      atMs: value.getUint32(10, true),
      drops: value.getUint32(14, true),
      offline: Boolean(value.getUint8(18)),
      value: value.getUint16(20, true),
    });
  }
  function decodeDiagnostic(value) {
    if (
      value?.byteLength !== 20 ||
      value.getUint8(0) !== 0xce ||
      value.getUint8(1) !== 1 ||
      value.getUint8(2) > 5 ||
      !validCommand(value.getUint8(8))
    )
      throw Error('Unsupported Chakshu voice diagnostic.');
    return Object.freeze({
      status: value.getUint8(2),
      enabled: Boolean(value.getUint8(3)),
      meanAbs: value.getUint16(4, true),
      peak: value.getUint16(6, true),
      candidate: value.getUint8(8),
      confidence: value.getUint16(9, true) / 1000,
      candidateAtMs: value.getUint32(11, true),
      candidateCount: value.getUint32(15, true),
      active: Boolean(value.getUint8(19)),
    });
  }
  function commandLabel(incoming) {
    if (incoming.command === WAKE) return 'Hey Snap';
    if (incoming.command === PHOTO) return 'Take a snap';
    if (incoming.command === VIDEO_START) return 'Record a video';
    if (incoming.command === VIDEO_STOP) return 'Stop video';
    if (incoming.command === AUDIO_ON) return 'Start audio';
    if (incoming.command === AUDIO_OFF) return 'Stop audio';
    if (incoming.command === DESCRIBE) return 'What do you see';
    if (incoming.command === STOP) return 'Stop';
    return 'Voice command';
  }
  function feedback(text, tone = 'listening', ttl = 0) {
    const element = root.document?.getElementById?.('heySynapFeedback'),
      label = root.document?.getElementById?.('heySynapFeedbackText');
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
    if (!element || !label) return;
    if (!text) {
      element.hidden = true;
      delete element.dataset.tone;
      label.textContent = '';
      return;
    }
    label.textContent = text;
    element.dataset.tone = tone;
    element.hidden = false;
    if (ttl > 0) feedbackTimer = setTimeout(() => feedback('', tone, 0), ttl);
  }
  function current(b) {
    return Boolean(
      binding === b &&
      root.SynapDevices?.connection === b.context &&
      api()?.state.owner === b.owner &&
      api()?.state.available &&
      supported(),
    );
  }
  async function write(b, op) {
    return b.context.mediaQueue(
      () => b.control.writeValueWithResponse(new Uint8Array([0xcc, PROTOCOL, op])),
      'Set Chakshu voice controls',
    );
  }
  function notify() {
    root.dispatchEvent?.(
      new CustomEvent('synap-chakshu-voice', { detail: { state, message, connected: Boolean(binding) } }),
    );
  }
  function close() {
    if (binding?.events && binding.handler)
      binding.events.removeEventListener('characteristicvaluechanged', binding.handler);
    binding = null;
    state = null;
    diagnostic = null;
    lastPoll = 0;
    clearTimeout(timer);
    timer = null;
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
    feedback('', 'listening', 0);
    notify();
  }
  function localMediaCommand(command) {
    return command === PHOTO || command === VIDEO_START || command === AUDIO_ON || command === DESCRIBE;
  }
  function perform(incoming) {
    // Firmware owns capture. The app only observes the event and syncs durable SD media later.
    return Promise.resolve({ local: true, command: incoming.command });
  }
  async function command(b, value) {
    if (!current(b) || document.visibilityState !== 'visible') return;
    const incoming = decode(value),
      delta = (incoming.sequence - b.sequence) >>> 0;
    if (delta >= 0x80000000) return; // stale poll after a newer notification
    state = incoming;
    if (!delta) {
      notify();
      return;
    }
    b.sequence = incoming.sequence;
    if (incoming.status !== 1 || !incoming.command) {
      notify();
      return;
    }
    if (incoming.command === WAKE) {
      message = 'Listening for command…';
      feedback('Hey Snap · Listening for command…', 'listening', 5200);
      notify();
      return;
    }
    const label = commandLabel(incoming);
    if (incoming.result === 1) {
      message = `Could not start · ${label}`;
      feedback(message, 'error', 5000);
      notify();
      return;
    }
    if (incoming.command === STOP) {
      message = '';
      feedback('Stopped on Chakshu', 'success', 2500);
      notify();
      return;
    }
    if (localMediaCommand(incoming.command) && incoming.result !== 3) {
      message = `Queued on Chakshu · ${label}`;
      feedback(message, 'heard', 2800);
      notify();
      return;
    }
    message = '';
    feedback(`Saved on Chakshu · ${label}`, 'success', 3500);
    if (localMediaCommand(incoming.command) && incoming.result === 3)
      root.dispatchEvent?.(new CustomEvent('synap-chakshu-media-pending', { detail: incoming }));
    notify();
  }
  async function sync() {
    const context = root.SynapDevices?.connection,
      owner = api()?.state.owner;
    if (binding && (binding.context !== context || binding.owner !== owner || !api()?.state.available || !supported()))
      close();
    if (pending) return;
    if (binding?.started && Date.now() - lastPoll < 1900) return;
    clearTimeout(timer);
    timer = null;
    if (!context || !owner || !api()?.state.available || !supported()) {
      notify();
      return;
    }
    pending = true;
    try {
      if (!binding) {
        const b = { context, owner, sequence: 0, queued: 0, actions: Promise.resolve(), started: false };
        binding = b;
        b.control = await context.mediaQueue(
          () => context.service.getCharacteristic(CONTROL),
          'Find Chakshu voice control',
        );
        if (!current(b)) return;
        b.events = await context.mediaQueue(
          () => context.service.getCharacteristic(EVENTS),
          'Find Chakshu voice events',
        );
        if (!current(b)) return;
        try {
          b.diagnostics = await context.mediaQueue(
            () => context.service.getCharacteristic(DIAGNOSTICS),
            'Find Chakshu voice diagnostics',
          );
        } catch (error) {
          b.diagnostics = null;
          root.dispatchEvent?.(
            new CustomEvent('synap-voice-diagnostic', {
              detail: { available: false, message: error.message || String(error) },
            }),
          );
        }
        state = decode(await context.mediaQueue(() => b.control.readValue(), 'Read Chakshu voice status'));
        b.sequence = state.sequence;
        b.handler = (event) => command(b, event.target.value).catch((error) => {
          if (current(b)) {
            message = error.message;
            notify();
          }
        });
        b.events.addEventListener('characteristicvaluechanged', b.handler);
        await context.mediaQueue(() => b.events.startNotifications(), 'Listen for Chakshu voice commands');
        b.started = true;
      }
      const b = binding;
      if (!current(b)) return;
      if (document.visibilityState === 'visible') {
        await write(b, 2);
        if (!current(b)) return;
        const value = await b.context.mediaQueue(() => b.control.readValue(), 'Check Chakshu voice status');
        if (current(b)) await command(b, value);
        if (current(b) && b.diagnostics) {
          const before = diagnostic?.candidateCount || 0,
            raw = await b.context.mediaQueue(
              () => b.diagnostics.readValue(),
              'Read Chakshu voice diagnostics',
            );
          if (current(b)) {
            diagnostic = decodeDiagnostic(raw);
            const candidateLabel = diagnostic.candidate
              ? commandLabel({ command: diagnostic.candidate })
              : 'None';
            root.dispatchEvent?.(
              new CustomEvent('synap-voice-diagnostic', {
                detail: {
                  available: true,
                  ...diagnostic,
                  candidateLabel,
                  confidencePercent: Math.round(diagnostic.confidence * 100),
                },
              }),
            );
            // Candidate scores are diagnostic-only. User-facing feedback is reserved
            // for accepted wake/command events so model exploration cannot obscure the UI.
          }
        }
      } else await write(b, 3);
      lastPoll = Date.now();
      message = '';
    } catch (error) {
      if (!binding?.started) close();
      if (error.code !== 'OPTIONAL_GATT_DEFERRED') message = error.message;
    } finally {
      pending = false;
      notify();
      if (context === root.SynapDevices?.connection && api()?.state.available)
        timer = setTimeout(sync, 2000);
    }
  }
  async function enabled(value) {
    const b = binding;
    if (!b) throw Error('Connect Chakshu first.');
    while (pending && current(b)) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!current(b)) throw Error('Chakshu connection changed.');
    pending = true;
    try {
      await write(b, value ? 1 : 0);
      if (current(b)) state = decode(await b.context.mediaQueue(() => b.control.readValue(), 'Read voice setting'));
      if (!value) feedback('', 'listening', 0);
      message = '';
      return state;
    } finally {
      pending = false;
      lastPoll = 0;
      notify();
    }
  }
  root.SynapChakshuVoice = Object.freeze({
    revision: '1.0.0-chakshu-voice8',
    decode,
    decodeDiagnostic,
    label: commandLabel,
    perform,
    sync,
    enabled,
    get state() { return state; },
    get diagnostic() { return diagnostic; },
    get message() { return message; },
  });
  for (const name of ['synap-chakshu-changed', 'synap-module-changed', 'synap-gatt-disconnected'])
    root.addEventListener?.(name, () => sync());
  root.document?.addEventListener?.('visibilitychange', () => {
    lastPoll = 0;
    sync();
  });
  if (root.document?.readyState === 'loading')
    root.document.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();
})(globalThis);