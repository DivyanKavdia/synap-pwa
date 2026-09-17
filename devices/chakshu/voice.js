/* Device-side commands use an explicit short foreground lease and the app's media queue. */
(function (root) {
  'use strict';
  const CONTROL = '4fa12356-0000-1000-8000-00805f9b34fb',
    EVENTS = '4fa12357-0000-1000-8000-00805f9b34fb',
    PROTOCOL = 2,
    PHOTO = 2,
    VIDEO_START = 3,
    VIDEO_STOP = 4,
    AUDIO_ON = 5,
    AUDIO_OFF = 6,
    DESCRIBE = 7,
    DURATION_BASE = 20,
    DURATION_LAST = 155;
  let binding = null,
    pending = false,
    timer = null,
    lastPoll = 0,
    message = '',
    state = null;
  const api = () => root.SynapChakshu;
  const supported = () => root.SynapCapabilities?.hasVoice(root.SynapModules?.client?.module);
  function validCommand(command) {
    return command === 0 ||
      (command >= PHOTO && command <= DESCRIBE) ||
      (command >= DURATION_BASE && command <= DURATION_LAST);
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
    lastPoll = 0;
    clearTimeout(timer);
    timer = null;
    notify();
  }
  async function highQualitySnap() {
    const connection = root.SynapDevices?.connection;
    if (!connection || !api()?.state.storageReady)
      throw Error('Insert an SD card and connect Chakshu for a full-quality snap.');
    const transfer = new root.SynapChakshuTransfer.Client(connection),
      saved = await transfer.savedPreview(),
      receipt = await root.SynapChakshuV2.moveSD(saved.path);
    if (!receipt?.visualId) throw Error('The snap could not be saved to the app.');
    root.dispatchEvent?.(new CustomEvent('synap-visual-library-updated'));
    return receipt.visualId;
  }
  async function perform(incoming) {
    const command = incoming.command;
    if (command === PHOTO) return highQualitySnap();
    if (command === VIDEO_START) return root.SynapChakshuV2.startOffline(0, 10);
    if (command === VIDEO_STOP) return api().stop();
    if (command === AUDIO_ON) return api().setAudio(true);
    if (command === AUDIO_OFF) return api().setAudio(false);
    if (command === DESCRIBE) return root.SynapChakshuV2.describeNow();
    if (command >= DURATION_BASE && command <= DURATION_LAST) {
      if (!Number.isInteger(incoming.value) || incoming.value < 1 || incoming.value > 600)
        throw Error('Chakshu reported an invalid recording length.');
      return root.SynapChakshuV2.startOffline(0, incoming.value);
    }
    throw Error('Unsupported local voice command.');
  }
  async function command(b, value) {
    if (!current(b) || document.visibilityState !== 'visible') return;
    const incoming = decode(value),
      delta = (incoming.sequence - b.sequence) >>> 0;
    if (delta >= 0x80000000) return; // stale poll after a newer notification
    state = incoming;
    notify();
    if (!delta) return;
    b.sequence = incoming.sequence;
    if (incoming.result !== 2 || incoming.status !== 1 || !incoming.command) return;
    if (b.queued >= 4) {
      message = 'Voice commands are busy. Please try again.';
      notify();
      return;
    }
    b.queued++;
    const received = Date.now();
    b.actions = b.actions
      .then(async () => {
        if (!current(b) || document.visibilityState !== 'visible' || Date.now() - received > 15000)
          return;
        try {
          await perform(incoming);
          if (current(b)) message = '';
        } catch (error) {
          if (current(b)) message = error.message;
        } finally {
          notify();
        }
      })
      .finally(() => {
        b.queued--;
      });
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
        state = decode(await context.mediaQueue(() => b.control.readValue(), 'Read Chakshu voice status'));
        b.sequence = state.sequence;
        b.handler = (event) => command(b, event.target.value).catch((error) => {
          if (current(b)) {
            message = error.message;
            notify();
          }
        });
        b.events.addEventListener('characteristicvaluechanged', b.handler);
        await context.mediaQueue(() => b.events.startNotifications(), 'Listen for Hey Synap commands');
        b.started = true;
      }
      const b = binding;
      if (!current(b)) return;
      if (document.visibilityState === 'visible') {
        await write(b, 2);
        if (!current(b)) return;
        const value = await b.context.mediaQueue(() => b.control.readValue(), 'Check Chakshu voice status');
        if (current(b)) await command(b, value);
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
      message = '';
      return state;
    } finally {
      pending = false;
      lastPoll = 0;
      notify();
    }
  }
  root.SynapChakshuVoice = Object.freeze({
    decode,
    perform,
    sync,
    enabled,
    get state() { return state; },
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