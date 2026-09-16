/* The Device panel follows the connected module's supported and ready flags. */
(function (root) {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const labels = {
    audio: 'Microphone',
    camera: 'Camera',
    sd: 'SD card',
    touch: 'Touch control',
    battery: 'Battery sensor',
    standby: 'Standby',
  };
  function render() {
    const panel = byId('moduleSettings'),
      api = root.SynapModules,
      client = api?.client,
      info = client?.module;
    if (!panel) return;
    panel.hidden = !client;
    const detailsUnavailable = client?.available && !info;
    byId('moduleName').textContent = info
      ? info.name
      : detailsUnavailable
        ? 'Audio pendant'
        : 'Detecting module…';
    byId('moduleBoard').textContent = info
      ? info.board
      : detailsUnavailable
        ? 'Extra device features are unavailable on this connection.'
        : 'Reading connected hardware';
    const chips = byId('moduleFeatures');
    chips.replaceChildren();
    if (info)
      for (const [key, label] of Object.entries(labels)) {
        if (!root.SynapCapabilities.supports(info, key)) continue;
        const chip = document.createElement('span');
        chip.className = 'module-feature';
        const ready = root.SynapCapabilities.ready(info, key);
        chip.textContent = label + (info.legacy ? '' : ready ? ' · ready' : ' · unavailable');
        chip.dataset.ready = info.legacy ? 'unknown' : String(ready);
        chips.append(chip);
      }
    const caps = root.SynapCapabilities,
      chakshu = caps.isChakshu(info),
      status = client?.status;
    const experience = byId('moduleExperience');
    if (experience) {
      const recoveryMs = root.SynapDisconnectProtection?.capacityMs() || 0;
      experience.textContent = !info
        ? ''
        : chakshu
          ? 'Audio builds transcripts and memories. Photos, video and soundtracks save only to this phone. Bluetooth video uses a limited frame rate. Local voice commands are off.'
          : caps.profile(info)
            ? 'Audio recording, transcripts and memories.' +
              (caps.ready(info, 'touch') ? ' Touch control is available.' : '') +
              (recoveryMs
                ? ' Audio recovery: up to ' +
                  Math.round(recoveryMs / 10) / 100 +
                  ' seconds across brief disconnects.'
                : ' Keep the app open and your pendant nearby for continuous audio.')
            : 'Capabilities could not be verified. Refresh status before recording.';
    }
    byId('chakshuChecks').hidden = !chakshu;
    byId('moduleRefresh').disabled = !client || client.pending || client.busy;
    if (!chakshu) {
      byId('moduleStatus').textContent =
        client?.error ||
        (info?.legacy ? 'Earlier firmware detected. Update for hardware readiness checks.' : '');
      return;
    }
    byId('chakshuStorage').textContent =
      status?.ready & 4
        ? status.freeMiB.toLocaleString() +
          ' MiB free of ' +
          status.totalMiB.toLocaleString() +
          ' MiB'
        : 'SD card unavailable · check the card, then refresh hardware';
    byId('chakshuCamera').textContent =
      info.sensor === 0x3660
        ? 'OV3660 camera'
        : info.sensor
          ? 'Camera sensor 0x' + info.sensor.toString(16).toUpperCase()
          : 'Camera sensor unavailable';
    const names = {
      1: 'Checking hardware',
      2: 'Saving photo',
      3: 'Recording 10-second WAV',
      4: 'Recording silent camera clip',
    };
    const result =
      client.error ||
      (status?.state === 3
        ? api.ERRORS[status.error] || 'Hardware check failed.'
        : status?.state === 1
          ? (names[status.operation] || 'Working') + '… ' + status.progress + '%'
          : status?.state === 2
            ? status.operation === 1
              ? 'Hardware check complete.'
              : 'Saved ' + status.bytes.toLocaleString() + ' bytes to SD.'
            : 'Ready for a hardware check.');
    byId('moduleStatus').textContent = result;
    byId('chakshuFile').textContent = client.path
      ? (status?.state === 3 ? 'Partial file: ' : 'File: ') + client.path
      : '';
    for (const button of document.querySelectorAll('[data-chakshu-operation]')) {
      const op = Number(button.dataset.chakshuOperation);
      const ready = caps.hardwareCheck(info, op, true);
      button.disabled =
        client.pending || client.busy || !ready || client.context.canUse?.() === false;
    }
    const progress = byId('chakshuProgress');
    progress.hidden = !client.busy;
    progress.value = status?.progress || 0;
  }
  function init() {
    byId('moduleRefresh')?.addEventListener('click', () => root.SynapModules.refresh());
    for (const button of document.querySelectorAll('[data-chakshu-operation]'))
      button.addEventListener('click', async () => {
        try {
          await root.SynapModules.run(Number(button.dataset.chakshuOperation));
        } catch (error) {
          byId('moduleStatus').textContent = error.message;
        }
        render();
      });
    root.addEventListener('synap-module-changed', render);
    render();
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
