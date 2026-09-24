/*
 * Hey Snap is device-owned and remains armed whether or not Chakshu is linked
 * to the PWA. Voice-initiated media is always durable SD media. PWA/TTP live
 * capture remains a separate BLE-to-phone path and resource admission prevents
 * either path from overlapping camera/microphone/OTA work.
 *
 * The PWA subscribes to voice-result notifications once per connection. There
 * is no background status/diagnostics polling on the shared GATT queue.
 */
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
    STOP = 8,
    VOICE_ON = 1,
    ENABLE_ATTEMPTS = 3,
    ENABLE_RETRY_MS = 5000,
    DEFERRED_RETRY_MS = 15000,
    SEEN_PREFIX = 'synap-chakshu-voice-seen-v1:',
    LAST_PREFIX = 'synap-chakshu-voice-last-v1:';
  let binding = null,
    pending = false,
    timer = null,
    message = '',
    state = null,
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
    if (incoming.command === DESCRIBE) return 'Explain what you see';
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
  function outcomeMessage(incoming) {
    if (!incoming?.sequence || !incoming.command) return '';
    if (incoming.command === WAKE)
      return incoming.result === 1 ? 'Hey Snap wake failed.' : 'Hey Snap heard. Listening for command.';
    const noun =
      incoming.command === PHOTO ? 'photo' :
      incoming.command === VIDEO_START ? 'video' :
      incoming.command === AUDIO_ON ? 'audio' : '';
    if (noun) {
      if (incoming.result === 3) return 'Voice ' + noun + ' saved to Chakshu SD.';
      if (incoming.result === 1)
        return 'Voice ' + noun + ' failed on Chakshu (code ' + incoming.value + ').';
      if (incoming.result === 0 || incoming.result === 2)
        return incoming.command === AUDIO_ON
          ? 'Voice audio accepted · saving to Chakshu SD for up to ' + (incoming.value || 60) + ' seconds.'
          : 'Voice ' + noun + ' accepted · saving to Chakshu SD.';
      return '';
    }
    if (incoming.command === DESCRIBE) {
      if (incoming.result === 3)
        return 'Voice Explain what you see photo saved to Chakshu SD. Sync it to generate the description.';
      if (incoming.result === 1)
        return 'Voice Explain what you see failed on Chakshu (code ' + incoming.value + ').';
      if (incoming.result === 0 || incoming.result === 2)
        return 'Voice Explain what you see accepted · saving the photo to Chakshu SD.';
      return '';
    }
    if (incoming.command === STOP && (incoming.result === 0 || incoming.result === 2))
      return 'Voice SD capture stop command received.';
    return '';
  }
  function surfaceOutcome(b, incoming) {
    const text = outcomeMessage(incoming);
    if (!text) return false;
    const signature = [incoming.sequence, incoming.command, incoming.result, incoming.atMs, incoming.value].join(':'),
      deviceId = String(b?.context?.deviceId || b?.context?.device?.id || 'unknown'),
      key = SEEN_PREFIX + deviceId;
    try {
      if (root.localStorage?.getItem?.(key) === signature) return false;
      root.localStorage?.setItem?.(key, signature);
      if (incoming.command !== WAKE)
        root.localStorage?.setItem?.(
          LAST_PREFIX + deviceId,
          JSON.stringify({ ...incoming, label: commandLabel(incoming), message: text, deviceId, seenAt: new Date().toISOString() }),
        );
    } catch (_) {}
    message = text;
    feedback(text, incoming.result === 1 ? 'error' : incoming.result === 3 ? 'saved' : 'listening', incoming.command === WAKE ? 3500 : 10000);
    root.dispatchEvent?.(
      new CustomEvent('synap-chakshu-voice-result', {
        detail: { ...incoming, label: commandLabel(incoming), message: text, deviceId },
      }),
    );
    return true;
  }
  function lastOutcome(deviceId) {
    const id = String(deviceId || root.SynapDevices?.connection?.deviceId || '');
    if (!id) return null;
    try {
      const parsed = JSON.parse(root.localStorage?.getItem?.(LAST_PREFIX + id) || 'null');
      return parsed && parsed.deviceId === id && parsed.message ? Object.freeze(parsed) : null;
    } catch (_) {
      return null;
    }
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
      new CustomEvent('synap-chakshu-voice', {
        detail: {
          state,
          message,
          connected: Boolean(binding),
          standDown: Boolean(binding && !binding.ready),
        },
      }),
    );
  }
  function detach(b) {
    try {
      if (b?.events && b?.handler) b.events.removeEventListener('characteristicvaluechanged', b.handler);
    } catch (_) {}
  }
  function close() {
    const b = binding;
    binding = null;
    detach(b);
    state = null;
    clearTimeout(timer);
    timer = null;
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
    feedback('', 'listening', 0);
    notify();
  }
  function perform(incoming) {
    // Firmware owns voice capture and persists it to SD. The PWA only observes
    // the result and later syncs the durable file into Memories.
    return Promise.resolve({ local: true, command: incoming.command });
  }
  function onVoiceEvent(b, event) {
    if (!current(b) || event?.target !== b.events) return;
    try {
      state = decode(event.target.value);
      surfaceOutcome(b, state);
      notify();
    } catch (error) {
      message = error.message;
      notify();
    }
  }
  async function sync() {
    const context = root.SynapDevices?.connection,
      owner = api()?.state.owner;
    if (
      binding &&
      (binding.context !== context ||
        binding.owner !== owner ||
        !api()?.state.available ||
        !supported())
    )
      close();
    if (pending) return;
    clearTimeout(timer);
    timer = null;
    if (!context || !owner || !api()?.state.available || !supported()) {
      notify();
      return;
    }
    if (binding?.ready) return;
    pending = true;
    let deferred = false;
    try {
      const b = binding || (binding = { context, owner, attempts: 0, ready: false });
      b.attempts += 1;
      if (!b.control)
        b.control = await context.mediaQueue(
          () => context.service.getCharacteristic(CONTROL),
          'Find Chakshu voice control',
        );
      if (!current(b)) return;
      if (!b.events) {
        b.events = await context.mediaQueue(
          () => context.service.getCharacteristic(EVENTS),
          'Find Chakshu voice events',
        );
        if (!current(b)) return;
        b.handler = (event) => onVoiceEvent(b, event);
        b.events.addEventListener('characteristicvaluechanged', b.handler);
        await context.mediaQueue(() => b.events.startNotifications(), 'Subscribe Chakshu voice events');
        if (!current(b)) return;
      }
      // VOICE_ON is idempotent on the new firmware and explicitly reverses the
      // old shell's connect-time stand-down if an upgrade happens mid-session.
      await write(b, VOICE_ON);
      if (!current(b)) return;
      state = decode(await context.mediaQueue(() => b.control.readValue(), 'Read Chakshu voice status'));
      b.ready = Boolean(state.enabled);
      surfaceOutcome(b, state);
      message = b.ready ? message : 'Hey Snap is waiting for the Chakshu always-on voice firmware.';
    } catch (error) {
      deferred = error.code === 'OPTIONAL_GATT_DEFERRED';
      if (deferred && binding) binding.attempts -= 1;
      else message = error.message;
    } finally {
      pending = false;
      notify();
      const b = binding;
      if (b && !b.ready && current(b) && (deferred || b.attempts < ENABLE_ATTEMPTS))
        timer = setTimeout(sync, deferred ? DEFERRED_RETRY_MS : ENABLE_RETRY_MS);
    }
  }
  // Called immediately before an app-requested disconnect. Voice itself needs
  // no ownership handoff; only detach the browser listener from the dying link.
  function release() {
    close();
  }
  async function enabled(value) {
    if (!value) throw Error('Hey Snap is always enabled on Chakshu.');
    const b = binding;
    if (!b) throw Error('Connect Chakshu first.');
    while (pending && current(b)) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!current(b)) throw Error('Chakshu connection changed.');
    pending = true;
    try {
      await write(b, VOICE_ON);
      if (current(b))
        state = decode(await b.context.mediaQueue(() => b.control.readValue(), 'Read voice setting'));
      b.ready = Boolean(state?.enabled);
      return state;
    } finally {
      pending = false;
      notify();
    }
  }
  async function diagnose() {
    const b = binding;
    if (!b) throw Error('Connect Chakshu first.');
    const characteristic = await b.context.mediaQueue(
      () => b.context.service.getCharacteristic(DIAGNOSTICS),
      'Find Chakshu voice diagnostics',
    );
    if (!current(b)) throw Error('Chakshu connection changed.');
    const value = decodeDiagnostic(
      await b.context.mediaQueue(() => characteristic.readValue(), 'Read Chakshu voice diagnostics'),
    );
    root.dispatchEvent?.(
      new CustomEvent('synap-voice-diagnostic', {
        detail: {
          available: true,
          ...value,
          candidateLabel: value.candidate ? commandLabel({ command: value.candidate }) : 'None',
          confidencePercent: Math.round(value.confidence * 100),
        },
      }),
    );
    return value;
  }
  root.SynapChakshuVoice = Object.freeze({
    revision: '1.0.0-chakshu-voice13',
    decode,
    decodeDiagnostic,
    label: commandLabel,
    perform,
    sync,
    release,
    enabled,
    diagnose,
    lastOutcome,
    get state() { return state; },
    get message() { return message; },
    get standDown() { return Boolean(binding && !binding.ready); },
  });
  for (const name of ['synap-chakshu-changed', 'synap-module-changed', 'synap-gatt-disconnected'])
    root.addEventListener?.(name, () => sync());
  if (root.document?.readyState === 'loading')
    root.document.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();
})(globalThis);
