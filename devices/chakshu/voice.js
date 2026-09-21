/*
 * Hey Snap is device-owned and runs only while Chakshu is NOT connected to this app.
 *
 * Whenever the PWA holds the GATT link it is the single source of commands and
 * operations, so the firmware wake engine is stood down on connect and handed
 * back on disconnect. Two owners issuing capture commands at once is what put
 * the SD card and the audio transport into contention: the old 1.9-second
 * status + diagnostics poll timed out on the shared media queue, stalled audio
 * delivery, and dropped the link with the SD card still unmounted.
 *
 * A stood-down device is never read again. Diagnostics are available on demand
 * through diagnose(), not on a timer.
 */
(function (root) {
  'use strict';
  const CONTROL = '4fa12356-0000-1000-8000-00805f9b34fb',
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
    // Control-characteristic opcodes. A separate number space from the command
    // ids above: 0/1 disable and enable the wake engine, 2/3 are the foreground
    // and background leases the app no longer takes.
    VOICE_OFF = 0,
    VOICE_ON = 1,
    STAND_DOWN_ATTEMPTS = 3,
    STAND_DOWN_RETRY_MS = 5000,
    // While the media queue is closed for capture or recovery no GATT request
    // is issued at all, so re-checking is cheap and may wait as long as it must.
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
    if (incoming.command === DESCRIBE) return 'What do you see';
    if (incoming.command === STOP) return 'Stop';
    return 'Voice command';
  }
  /* Wake feedback belongs to the disconnected device now. This only clears a
   * banner an earlier build may have left on screen. */
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
      return incoming.result === 0
        ? 'Hey Snap heard while disconnected. No photo or video command completed.'
        : '';
    const noun =
      incoming.command === PHOTO
        ? 'photo'
        : incoming.command === VIDEO_START
          ? 'video'
          : incoming.command === AUDIO_ON
            ? 'audio'
            : incoming.command === DESCRIBE
              ? 'describe photo'
              : '';
    if (noun) {
      if (incoming.result === 3) {
        if (incoming.command === DESCRIBE)
          return 'Offline describe photo saved to Chakshu SD. Sync it to Memories for visual description.';
        return 'Offline ' + noun + ' saved to Chakshu SD.';
      }
      if (incoming.result === 1)
        return 'Offline ' + noun + ' failed on Chakshu (code ' + incoming.value + ').';
      if (incoming.result === 0) return 'Offline ' + noun + ' command accepted by Chakshu.';
      return '';
    }
    if (incoming.command === STOP && incoming.result === 0) return 'Offline capture stop command received.';
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
      root.localStorage?.setItem?.(
        LAST_PREFIX + deviceId,
        JSON.stringify({ ...incoming, label: commandLabel(incoming), message: text, deviceId, seenAt: new Date().toISOString() }),
      );
    } catch (_) {}
    message = text;
    feedback(text, incoming.result === 1 ? 'error' : incoming.result === 3 ? 'saved' : 'listening', 10000);
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
          standDown: Boolean(binding?.standDown),
        },
      }),
    );
  }
  function close() {
    binding = null;
    state = null;
    clearTimeout(timer);
    timer = null;
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
    feedback('', 'listening', 0);
    notify();
  }
  function perform(incoming) {
    // Firmware owns capture. The app only observes the event and syncs durable SD media later.
    return Promise.resolve({ local: true, command: incoming.command });
  }
  /**
   * Hand the microphone to whichever side owns it.
   *
   * Disconnected, this does nothing at all: the firmware is listening for Hey
   * Snap and recording to SD on its own. Connected, it writes VOICE_OFF once,
   * confirms the device reports itself disabled, and then stops touching GATT.
   */
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
    if (binding?.standDown) return;
    pending = true;
    let deferred = false;
    try {
      const b = binding || (binding = { context, owner, attempts: 0, standDown: false });
      b.attempts += 1;
      if (!b.control) {
        b.control = await context.mediaQueue(
          () => context.service.getCharacteristic(CONTROL),
          'Find Chakshu voice control',
        );
        if (!current(b)) return;
      }
      await write(b, VOICE_OFF);
      if (!current(b)) return;
      state = decode(
        await context.mediaQueue(() => b.control.readValue(), 'Confirm Chakshu voice stood down'),
      );
      b.standDown = !state.enabled;
      const surfaced = b.standDown && surfaceOutcome(b, state);
      if (!surfaced) {
        message = b.standDown ? '' : 'Chakshu is still listening for Hey Snap.';
        feedback('', 'listening', 0);
      }
    } catch (error) {
      deferred = error.code === 'OPTIONAL_GATT_DEFERRED';
      // A deferred request never reached the device, so it must not spend the
      // retry budget that exists for a device which answers and stays enabled.
      if (deferred && binding) binding.attempts -= 1;
      else message = error.message;
      // The binding is kept even when discovery itself failed, so the bounded
      // retry below applies to it rather than restarting from zero on the next
      // connection event.
    } finally {
      pending = false;
      notify();
      const b = binding;
      if (b && !b.standDown && current(b) && (deferred || b.attempts < STAND_DOWN_ATTEMPTS))
        timer = setTimeout(sync, deferred ? DEFERRED_RETRY_MS : STAND_DOWN_RETRY_MS);
    }
  }
  /**
   * Give Hey Snap back before the app drops the link.
   *
   * Best effort only. An unexpected disconnect — out of range, flat battery, a
   * dropped GATT link — gives the app no chance to write anything, so firmware
   * must also re-arm the wake engine whenever the BLE link goes down. This only
   * shortens the gap after a clean, app-initiated disconnect.
   */
  function release() {
    const b = binding;
    if (!b?.control || !b.standDown) return;
    b.standDown = false;
    b.attempts = 0;
    write(b, VOICE_ON).catch(() => {});
    // If the link survives the request after all, stand the device down again.
    clearTimeout(timer);
    timer = setTimeout(sync, 1500);
  }
  /** Manual override, kept for diagnostics. Enabling while connected would put
   * two owners back on the same microphone, so it is refused. */
  async function enabled(value) {
    const b = binding;
    if (!b) throw Error('Connect Chakshu first.');
    if (value) throw Error('Hey Snap runs only while Chakshu is disconnected from this app.');
    while (pending && current(b)) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!current(b)) throw Error('Chakshu connection changed.');
    pending = true;
    try {
      await write(b, VOICE_OFF);
      if (current(b))
        state = decode(await b.context.mediaQueue(() => b.control.readValue(), 'Read voice setting'));
      b.standDown = !state?.enabled;
      feedback('', 'listening', 0);
      message = '';
      return state;
    } finally {
      pending = false;
      notify();
    }
  }
  /** One-shot classifier read, on request. Never on a timer: polling this
   * characteristic every 1.9 seconds is what stalled the audio transport. */
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
    revision: '1.0.0-chakshu-voice12',
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
    get standDown() { return Boolean(binding?.standDown); },
  });
  for (const name of ['synap-chakshu-changed', 'synap-module-changed', 'synap-gatt-disconnected'])
    root.addEventListener?.(name, () => sync());
  if (root.document?.readyState === 'loading')
    root.document.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();
})(globalThis);
