/* Account-scoped Settings installation; all device writes use the app-owned queue. */
(function (root) {
  'use strict';
  let binding = null,
    remote = null,
    running = false,
    controller = null,
    task = null,
    message = '',
    checking = false,
    wake = null;
  const api = () => root.SynapChakshu;
  const changed = () => root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
  function current(b) {
    return (
      b &&
      binding === b &&
      b.context === root.SynapDevices?.connection &&
      b.owner === api()?.state.owner &&
      b.owner === root.SynapAuth?.session()?.profile?.uid &&
      api().state.devices.some((d) => d.deviceId === b.context.deviceId)
    );
  }
  function idle() {
    return (
      document.body.dataset.state === 'idle' &&
      !root.SynapAppControls?.recordingState().active &&
      !api()?.busy &&
      !root.SynapModules?.busy
    );
  }
  function render() {
    const install = document.getElementById('chakshuModelInstall');
    if (!install) return;
    const connected = current(binding),
      embedded = connected && remote?.embedded,
      active = connected && [1, 2].includes(remote?.state);
    install.hidden = Boolean(embedded);
    install.disabled = running || !connected || !remote?.supported || !idle() || remote.state === 3;
    install.textContent = active ? 'Resume installation' : 'Install voice model';
    const cancel = document.getElementById('chakshuModelCancel');
    cancel.hidden = Boolean(embedded) || (!running && !active);
    cancel.disabled = !connected;
    const restart = document.getElementById('chakshuModelRestart');
    restart.hidden = Boolean(embedded) || remote?.state !== 3;
    restart.disabled = running || !connected || !idle();
    const progress = document.getElementById('chakshuModelProgress');
    progress.hidden = Boolean(embedded) || (!running && !active && remote?.state !== 3);
    progress.value = remote ? Math.floor((remote.offset * 100) / remote.total) : 0;
    document.getElementById('chakshuModelStatus').textContent =
      message ||
      (embedded
        ? 'Voice model included in firmware and stored in internal flash. No SD card required. Future firmware updates include the model.'
        : remote?.state === 3
          ? 'Voice model installed. Restart Chakshu to activate it.'
          : active
            ? `Installation paused at ${progress.value}%. Resume within 15 minutes, or cancel.`
            : connected && remote
              ? 'Update Chakshu firmware to install the model in internal flash without an SD card. This older firmware also supports installation to SD below.'
              : 'Connect your associated Chakshu to install the voice model.');
    const manual = document.getElementById('chakshuModelManual');
    if (manual) manual.hidden = Boolean(embedded);
  }
  async function sync() {
    if (binding && !current(binding)) {
      controller?.abort();
      binding = null;
      remote = null;
      message = '';
    }
    render();
    const context = root.SynapDevices?.connection,
      owner = api()?.state.owner;
    if (
      binding ||
      checking ||
      running ||
      !context ||
      !owner ||
      !api()?.state.available ||
      !api().state.devices.some((d) => d.deviceId === context.deviceId) ||
      !idle()
    )
      return;
    const b = { context, owner };
    binding = b;
    checking = true;
    b.client = new root.SynapChakshuModelTransfer.Client(context, () => {
      if (!current(b))
        throw Error('Connection or account changed. Reconnect Chakshu to resume installation.');
    });
    try {
      remote = await b.client.connect();
      message = '';
    } catch (e) {
      if (current(b)) {
        message = e.message;
        if (e.code === 'OPTIONAL_GATT_DEFERRED') binding = null;
      }
    } finally {
      checking = false;
      render();
      if (binding) changed();
      else setTimeout(sync, 2000);
    }
  }
  async function perform(action) {
    if (running || !current(binding) || !idle()) return;
    const b = binding;
    running = true;
    controller = new AbortController();
    message = '';
    render();
    changed();
    try {
      wake = await navigator.wakeLock?.request('screen').catch(() => null);
      if (!current(b)) return;
      await action(b, controller.signal);
    } catch (e) {
      if (current(b))
        message =
          e.name === 'AbortError' ? 'Installation paused. Resume or cancel below.' : e.message;
    } finally {
      await wake?.release().catch(() => {});
      wake = null;
      running = false;
      controller = null;
      if (current(b)) {
        try {
          remote = await b.client.read();
        } catch (_) {}
      }
      render();
      changed();
    }
  }
  function install() {
    if (remote?.embedded) return;
    task = perform(async (b, signal) => {
      message = 'Downloading and checking the voice model (2.18 MB)…';
      render();
      const bytes = await root.SynapChakshuModelTransfer.download(signal);
      await b.client.install(bytes, signal, (status) => {
        if (!current(b)) return;
        remote = status;
        message =
          status.state === 3
            ? 'Voice model installed. Restart Chakshu to activate it.'
            : status.state === 2
              ? 'Verifying the model on the SD card…'
              : `Installing voice model… ${Math.floor((status.offset * 100) / status.total)}%`;
        render();
      });
    });
    return task;
  }
  async function cancel() {
    controller?.abort();
    await task;
    return perform(async (b) => {
      message = 'Cancelling installation…';
      render();
      const result = await b.client.cancel();
      message =
        result?.state === 3
          ? 'Installation already finished. Restart Chakshu to activate it.'
          : 'Installation cancelled. Existing recordings and model are preserved.';
    });
  }
  function restart() {
    task = perform(async (b) => {
      await b.client.restart();
      message = 'Restarting Chakshu. Reconnect to check voice controls.';
    });
    return task;
  }
  root.SynapChakshuModel = {
    install,
    cancel,
    restart,
    sync,
    get busy() {
      return running || Boolean(current(binding) && [1, 2, 5].includes(remote?.state));
    },
  };
  function init() {
    document.getElementById('chakshuModelInstall')?.addEventListener('click', install);
    document.getElementById('chakshuModelCancel')?.addEventListener('click', cancel);
    document.getElementById('chakshuModelRestart')?.addEventListener('click', restart);
    sync();
  }
  for (const name of ['synap-chakshu-changed', 'synap-gatt-disconnected', 'synap-module-changed'])
    root.addEventListener(name, sync);
  // Firmware/model checks become eligible after the connection reaches idle.
  new MutationObserver(sync).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-state'],
  });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
