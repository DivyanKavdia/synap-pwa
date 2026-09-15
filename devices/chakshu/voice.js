/* Device-side commands use an explicit, short PWA lease and the app's GATT queue. */
(function (root) {
  'use strict';
  const CONTROL = '4fa12356-0000-1000-8000-00805f9b34fb',
    EVENTS = '4fa12357-0000-1000-8000-00805f9b34fb';
  let binding = null,
    pending = false,
    timer = null,
    lastPoll = 0,
    message = '',
    readError = '',
    state = null;
  const api = () => root.SynapChakshu;
  function decode(value) {
    if (
      value?.byteLength !== 20 ||
      value.getUint8(0) !== 0xcd ||
      value.getUint8(1) !== 1 ||
      value.getUint8(2) > 5 ||
      value.getUint8(8) > 5
    )
      throw Error('Unsupported voice status.');
    return {
      status: value.getUint8(2),
      enabled: Boolean(value.getUint8(3)),
      sequence: value.getUint32(4, true),
      command: value.getUint8(8),
      result: value.getUint8(9),
      drops: value.getUint32(14, true),
    };
  }
  function render() {
    const container = document.getElementById('chakshuVoice');
    if (!container) return;
    container.hidden = !api()?.state.available;
    const supported = root.SynapCapabilities.hasVoice(root.SynapModules?.client?.module);
    const toggle = document.getElementById('chakshuVoiceEnabled');
    toggle.disabled = !binding || pending || !state || ![1, 5].includes(state.status);
    toggle.checked = Boolean(state?.enabled);
    const labels = [
      'Starting local model…',
      'Listening for “Hi Chakshu”.',
      'Update Chakshu firmware to install the voice model, or use the older SD installer below.',
      'Not enough memory for the voice model. Restart Chakshu.',
      'Voice model could not load. Restart Chakshu; if this persists, update its firmware.',
      'Voice controls are off.',
    ];
    document.getElementById('chakshuVoiceStatus').textContent =
      readError ||
      message ||
      (!supported
        ? 'Update Chakshu firmware for local voice controls.'
        : state
          ? labels[state.status]
          : 'Connect Chakshu to check voice controls.');
  }
  function current(b) {
    return (
      binding === b &&
      root.SynapDevices.connection === b.context &&
      api().state.owner === b.owner &&
      api().state.available
    );
  }
  async function write(b, op) {
    return b.context.mediaQueue(
      () => b.control.writeValueWithResponse(new Uint8Array([0xcc, 1, op])),
      'Set Chakshu voice controls',
    );
  }
  function close() {
    if (binding?.events)
      binding.events.removeEventListener('characteristicvaluechanged', binding.handler);
    binding = null;
    state = null;
    message = '';
    readError = '';
    lastPoll = 0;
    clearTimeout(timer);
    timer = null;
    render();
  }
  async function command(b, value) {
    if (!current(b) || document.visibilityState !== 'visible') return;
    const incoming = decode(value);
    const delta = (incoming.sequence - b.sequence) >>> 0;
    // A poll begun before a notification may finish afterward. Keep newer state.
    if (delta >= 0x80000000) return;
    state = incoming;
    readError = '';
    render();
    if (!delta) return;
    b.sequence = incoming.sequence;
    // Only commands delegated to this connected page may be performed here.
    if (incoming.result !== 2 || incoming.status !== 1 || !incoming.command) return;
    // Keep a stop arriving during startup, without blocking lease renewal.
    if (b.queued >= 4) {
      message = 'Voice commands are busy. Please try again.';
      render();
      return;
    }
    b.queued++;
    const received = Date.now();
    b.actions = b.actions
      .then(async () => {
        if (!current(b) || document.visibilityState !== 'visible' || Date.now() - received > 15000)
          return;
        try {
          await api().voiceCommand(incoming.command);
          if (current(b)) message = '';
        } catch (e) {
          if (current(b)) message = e.message;
        }
      })
      .finally(() => {
        b.queued--;
        render();
      });
  }
  async function sync() {
    const context = root.SynapDevices?.connection,
      owner = api()?.state.owner;
    if (
      binding &&
      (binding.context !== context || binding.owner !== owner || !api()?.state.available)
    )
      close();
    if (pending) return;
    // Media progress events update controls often; poll at most every two seconds.
    if (binding?.started && Date.now() - lastPoll < 1900) {
      render();
      return;
    }
    clearTimeout(timer);
    timer = null;
    if (
      !context ||
      !owner ||
      !api()?.state.available ||
      !root.SynapCapabilities.hasVoice(root.SynapModules?.client?.module)
    ) {
      render();
      return;
    }
    pending = true;
    try {
      if (!binding) {
        const b = { context, owner, sequence: 0, queued: 0, actions: Promise.resolve() };
        binding = b;
        b.control = await context.mediaQueue(
          () => context.service.getCharacteristic(CONTROL),
          'Find voice control',
        );
        if (!current(b)) return;
        b.events = await context.mediaQueue(
          () => context.service.getCharacteristic(EVENTS),
          'Find voice events',
        );
        if (!current(b)) return;
        const value = await context.mediaQueue(() => b.control.readValue(), 'Read voice status');
        if (!current(b)) return;
        state = decode(value);
        readError = '';
        b.sequence = state.sequence;
        b.handler = (e) => {
          command(b, e.target.value).catch((e) => {
            if (current(b)) {
              message = e.message;
              render();
            }
          });
        };
        b.events.addEventListener('characteristicvaluechanged', b.handler);
        await context.mediaQueue(
          () => b.events.startNotifications(),
          'Listen for Chakshu commands',
        );
        b.started = true;
      }
      const b = binding;
      if (!current(b)) return;
      if (document.visibilityState === 'visible') {
        await write(b, 2);
        if (!current(b)) return;
        // Recover a lost notification only within this page's current lease.
        const value = await b.context.mediaQueue(
          () => b.control.readValue(),
          'Check local voice status',
        );
        if (current(b)) await command(b, value);
      } else await write(b, 3);
      lastPoll = Date.now();
    } catch (e) {
      // Recorder recovery/OTA owns the link. Let the lease expire without retrying
      // native requests in a tight loop or disconnecting the audio stream.
      if (context !== root.SynapDevices?.connection || owner !== api()?.state.owner) return;
      if (!binding?.started) close();
      if (e.code !== 'OPTIONAL_GATT_DEFERRED')
        readError =
          e.message === 'Unsupported voice status.'
            ? 'Could not read voice status. Update Chakshu firmware, then reconnect.'
            : e.message;
    } finally {
      pending = false;
      render();
      if (context === root.SynapDevices?.connection && api()?.state.available)
        timer = setTimeout(sync, 2000);
    }
  }
  async function enabled(value) {
    const b = binding;
    if (!b) return;
    while (pending && current(b)) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!current(b)) return;
    pending = true;
    render();
    try {
      await write(b, value ? 1 : 0);
      if (current(b))
        state = decode(
          await b.context.mediaQueue(() => b.control.readValue(), 'Read voice setting'),
        );
      message = '';
    } catch (e) {
      message = e.message;
    } finally {
      pending = false;
      lastPoll = 0;
      render();
      await sync();
    }
  }
  root.SynapChakshuVoice = {
    decode,
    get state() {
      return state;
    },
    sync,
    enabled,
  };
  for (const name of ['synap-chakshu-changed', 'synap-module-changed', 'synap-gatt-disconnected'])
    root.addEventListener(name, sync);
  document.addEventListener('visibilitychange', () => {
    lastPoll = 0;
    sync();
  });
  function init() {
    document
      .getElementById('chakshuVoiceEnabled')
      ?.addEventListener('change', (e) => enabled(e.target.checked));
    sync();
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
