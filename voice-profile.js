/* Synap Voice Profile: explicit, privacy-safe enrollment for owner speech. */
(function (root) {
  'use strict';
  const STYLE_ID = 'synapVoiceProfileStyle',
    RECORD_SECONDS = 10,
    TARGET_RATE = 16000;
  let status = null,
    busy = false,
    dialog = null,
    operation = null,
    refreshVersion = 0,
    scope = '';
  const $ = (s) => document.querySelector(s);
  function signedIn() {
    try {
      return Boolean(root.SynapAuth?.isSignedIn?.());
    } catch (_) {
      return false;
    }
  }
  function providerIsSynap() {
    try {
      return (
        String(
          JSON.parse(localStorage.getItem('synap-ai-provider-settings') || '{}').provider ||
            'synap',
        ) === 'synap'
      );
    } catch (_) {
      return true;
    }
  }
  const accountKey = () =>
    signedIn() ? String(root.SynapAuth?.session?.()?.profile?.uid || 'signed-in') : '';
  const capturing = () =>
    ['recording', 'starting', 'stopping', 'saving', 'updating'].includes(
      document.body?.dataset.state,
    );
  function abortError() {
    return new DOMException('Voice setup cancelled.', 'AbortError');
  }
  function cancellable(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const cancel = () => reject(abortError());
      signal.addEventListener('abort', cancel, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }
  async function request(path, options) {
    if (!root.SynapAuth?.authedFetch) throw new Error('Synap account is unavailable.');
    const response = await root.SynapAuth.authedFetch(path, options || {});
    let data = null;
    try {
      data = await response.json();
    } catch (_) {}
    if (!response.ok) {
      const e = new Error(data?.error?.message || 'HTTP ' + response.status);
      e.status = response.status;
      throw e;
    }
    return data;
  }
  function style() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
.synap-voice-profile{display:flex;align-items:center;gap:12px;margin-top:12px;padding:12px;border:1px solid var(--border,#dbe3ec);border-radius:14px;background:rgba(127,145,165,.05)}.synap-voice-profile-copy{min-width:0;flex:1;display:grid;gap:3px}.synap-voice-profile-copy strong{font-size:13px}.synap-voice-profile-copy span{font-size:11px;line-height:1.35;color:var(--muted,#64748b)}.synap-voice-profile-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.synap-voice-profile-actions button{border:0;border-radius:10px;padding:8px 10px;font:inherit;font-size:11px;font-weight:750;cursor:pointer}.synap-voice-primary{background:#102744;color:#fff}.synap-voice-secondary{background:rgba(127,145,165,.12);color:inherit}.synap-voice-profile-actions button:disabled{opacity:.45;cursor:not-allowed}.synap-voice-dialog{border:0;border-radius:22px;padding:0;width:min(440px,calc(100vw - 28px));max-width:440px;background:var(--surface,#fff);color:inherit;box-shadow:0 24px 80px rgba(15,23,42,.28)}.synap-voice-dialog::backdrop{background:rgba(15,23,42,.48);backdrop-filter:blur(2px)}.synap-voice-dialog-body{padding:22px;display:grid;gap:16px}.synap-voice-dialog h3{margin:0;font-size:20px}.synap-voice-dialog p{margin:0;color:var(--muted,#64748b);font-size:13px;line-height:1.5}.synap-voice-consent{display:flex;align-items:flex-start;gap:9px;font-size:12px;line-height:1.4}.synap-voice-consent input{margin-top:2px}.synap-voice-progress{display:grid;place-items:center;min-height:84px;border-radius:16px;background:rgba(127,145,165,.08);text-align:center}.synap-voice-progress strong{font-size:26px}.synap-voice-dialog-actions{display:flex;gap:8px;justify-content:flex-end}.synap-voice-dialog-actions button{border:0;border-radius:11px;padding:10px 14px;font:inherit;font-weight:750;cursor:pointer}.synap-voice-error{color:#a64040!important}.synap-voice-ready{color:#237a57!important}@media(max-width:560px){.synap-voice-profile{align-items:flex-start;flex-direction:column}.synap-voice-profile-actions{width:100%;justify-content:flex-start}.synap-voice-dialog-actions{justify-content:stretch}.synap-voice-dialog-actions button{flex:1}}
`;
    s.textContent +=
      '.synap-voice-name{display:grid;gap:6px;font-size:13px}.synap-voice-name input{box-sizing:border-box;width:100%;min-height:44px;border:1px solid var(--border);border-radius:10px;padding:10px;font:inherit;font-size:16px;color:inherit;background:var(--surface)}.synap-voice-dialog{max-height:calc(100dvh - 24px);overflow:auto}.synap-voice-dialog-actions{flex-wrap:wrap}.synap-voice-dialog-actions button{min-height:44px}.synap-voice-dialog [hidden]{display:none!important}';
    document.head.appendChild(s);
  }
  function row() {
    let host = $('#synapVoiceProfile');
    if (host) return host;
    const parent = $('#synapAccountFields');
    if (!parent) return null;
    host = document.createElement('div');
    host.id = 'synapVoiceProfile';
    host.className = 'synap-voice-profile';
    host.hidden = true;
    const copy = document.createElement('div');
    copy.className = 'synap-voice-profile-copy';
    const title = document.createElement('strong');
    title.textContent = 'Voice profile';
    const detail = document.createElement('span');
    detail.id = 'synapVoiceProfileStatus';
    detail.setAttribute('role', 'status');
    detail.textContent = 'Checking availability…';
    copy.append(title, detail);
    const actions = document.createElement('div');
    actions.className = 'synap-voice-profile-actions';
    const setup = document.createElement('button');
    setup.type = 'button';
    setup.id = 'synapVoiceProfileSetup';
    setup.className = 'synap-voice-primary';
    setup.textContent = 'Set up';
    setup.addEventListener('click', openEnrollment);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.id = 'synapVoiceProfileDelete';
    remove.className = 'synap-voice-secondary';
    remove.textContent = 'Delete';
    remove.hidden = true;
    remove.addEventListener('click', deleteProfile);
    actions.append(setup, remove);
    host.append(copy, actions);
    const connection = $('#synapConnectionDetails');
    if (connection) connection.before(host);
    else parent.appendChild(host);
    return host;
  }
  function render() {
    const host = row();
    if (!host) return;
    const detail = $('#synapVoiceProfileStatus'),
      setup = $('#synapVoiceProfileSetup'),
      remove = $('#synapVoiceProfileDelete');
    const visible = signedIn() && providerIsSynap();
    host.hidden = !visible;
    if (!visible) return;
    if (!status) {
      detail.textContent = 'Checking availability…';
      setup.disabled = true;
      remove.hidden = true;
      return;
    }
    if (!status.available) {
      detail.textContent =
        status.error || 'Voice recognition is temporarily unavailable. Try again later.';
      setup.disabled = true;
      remove.hidden = true;
      return;
    }
    setup.disabled = busy || status.supports_display_name !== true;
    remove.disabled = busy;
    if (status.supports_display_name !== true) {
      detail.textContent = 'Voice and name setup is waiting for the cloud update.';
      remove.hidden = !status.enrolled;
      return;
    }
    if (status.enrolled) {
      detail.textContent = 'Ready · confident matches use ' + (status.displayName || 'You') + ((status.sampleCount || 1) > 1 ? ' · ' + status.sampleCount + ' samples.' : '.');
      detail.classList.add('synap-voice-ready');
      setup.textContent = 'Manage';
      remove.hidden = false;
    } else {
      detail.classList.remove('synap-voice-ready');
      detail.textContent = 'Not set up · record about 10 seconds once.';
      setup.textContent = 'Set up';
      remove.hidden = true;
    }
  }
  function makeDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'synap-voice-dialog';
    dialog.id = 'synapVoiceProfileDialog';
    const body = document.createElement('div');
    body.className = 'synap-voice-dialog-body';
    const h = document.createElement('h3');
    h.id = 'synapVoiceTitle';
    h.textContent = 'Your voice and name';
    dialog.setAttribute('aria-labelledby', h.id);
    const intro = document.createElement('p');
    intro.textContent =
      'Confirm your name, then speak naturally for 10 seconds using your phone microphone in a quiet place. Your encrypted voice profile identifies confident matches in new memories; uncertain voices stay unnamed. The enrollment audio is not saved.';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'synap-voice-name';
    nameLabel.textContent = 'Your name';
    const name = document.createElement('input');
    name.id = 'synapVoiceName';
    name.type = 'text';
    name.autocomplete = 'name';
    name.maxLength = 80;
    name.required = true;
    nameLabel.append(name);
    const consent = document.createElement('label');
    consent.className = 'synap-voice-consent';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.id = 'synapVoiceConsent';
    const text = document.createElement('span');
    text.textContent =
      'I agree to create an encrypted voice profile for identifying my own speech in Synap memories.';
    consent.append(check, text);
    const progress = document.createElement('div');
    progress.className = 'synap-voice-progress';
    const progressText = document.createElement('div');
    const big = document.createElement('strong');
    big.id = 'synapVoiceCountdown';
    big.textContent = '10s';
    const small = document.createElement('p');
    small.id = 'synapVoicePrompt';
    small.textContent = 'When ready, start and speak in your normal voice.';
    progressText.append(big, small);
    progress.appendChild(progressText);
    const error = document.createElement('p');
    error.id = 'synapVoiceError';
    error.className = 'synap-voice-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'synap-voice-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'synap-voice-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeDialog);
    const start = document.createElement('button');
    start.type = 'button';
    start.id = 'synapVoiceStart';
    start.className = 'synap-voice-primary';
    start.textContent = 'Start recording';
    start.disabled = true;
    start.addEventListener('click', enroll);
    const saveName = document.createElement('button');
    saveName.id = 'synapVoiceSaveName';
    saveName.type = 'button';
    saveName.className = 'synap-voice-secondary';
    saveName.textContent = 'Save name';
    saveName.addEventListener('click', () => saveProfile(true));
    check.addEventListener('change', updateControls);
    name.addEventListener('input', updateControls);
    actions.append(cancel, saveName, start);
    body.append(h, intro, nameLabel, consent, progress, error, actions);
    dialog.appendChild(body);
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog();
    });
    dialog.addEventListener('close', () => operation?.abort());
    return dialog;
  }
  function validName() {
    const name = $('#synapVoiceName')?.value.normalize('NFKC').trim() || '';
    return name && name.length <= 80 && !/[:\x00-\x1f\x7f]/.test(name);
  }
  function updateControls() {
    const name = $('#synapVoiceName'),
      check = $('#synapVoiceConsent');
    if (!name || !check) return;
    name.disabled = check.disabled = busy;
    $('#synapVoiceStart').disabled = busy || !check.checked || !validName();
    $('#synapVoiceSaveName').disabled = busy || !validName();
  }
  function openEnrollment() {
    if (busy || !status?.available || !status.supports_display_name) return;
    if (capturing()) {
      const detail = $('#synapVoiceProfileStatus');
      if (detail) detail.textContent = 'Stop pendant listening before voice-profile setup.';
      return;
    }
    const d = makeDialog();
    const check = $('#synapVoiceConsent'),
      start = $('#synapVoiceStart'),
      error = $('#synapVoiceError'),
      count = $('#synapVoiceCountdown'),
      prompt = $('#synapVoicePrompt');
    check.checked = false;
    $('#synapVoiceName').value =
      status.displayName || root.SynapAuth?.session?.()?.profile?.name || '';
    $('#synapVoiceSaveName').hidden = !status.enrolled;
    start.textContent = status.enrolled ? 'Re-record voice' : 'Start recording';
    updateControls();
    error.hidden = true;
    count.textContent = RECORD_SECONDS + 's';
    prompt.textContent = 'When ready, start and speak in your normal voice.';
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }
  function closeDialog() {
    operation?.abort();
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }
  function concatFloat32(chunks) {
    const length = chunks.reduce((n, x) => n + x.length, 0),
      out = new Float32Array(length);
    let offset = 0;
    chunks.forEach((x) => {
      out.set(x, offset);
      offset += x.length;
    });
    return out;
  }
  function resample(input, sourceRate, targetRate) {
    if (sourceRate === targetRate) return input;
    const ratio = sourceRate / targetRate,
      length = Math.max(1, Math.floor(input.length / ratio)),
      out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio),
        end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j];
      out[i] = sum / (end - start);
    }
    return out;
  }
  function wav16(samples, rate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2),
      view = new DataView(buffer);
    function ascii(offset, text) {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    }
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i += 1) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(o, x < 0 ? x * 32768 : x * 32767, true);
      o += 2;
    }
    return buffer;
  }
  async function capture(seconds, onTick, signal) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Microphone access is unavailable in this browser.');
    const AudioContext = root.AudioContext || root.webkitAudioContext;
    if (!AudioContext) throw new Error('Audio capture is unavailable in this browser.');
    const context = new AudioContext(),
      chunks = [];
    let stream, source, processor, timer, interval;
    // Start/resume from the tap so iOS retains its user activation.
    const resumed = context.resume();
    resumed.catch(() => {});
    try {
      const pending = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      // Permission can resolve after Cancel or an account change.
      pending.then(
        (value) => {
          if (signal.aborted) value.getTracks().forEach((track) => track.stop());
        },
        () => {},
      );
      stream = await cancellable(pending, signal);
      await cancellable(resumed, signal);
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (!signal.aborted) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(context.destination);
      const started = Date.now();
      onTick(seconds);
      interval = setInterval(
        () => onTick(Math.max(0, Math.ceil(seconds - (Date.now() - started) / 1000))),
        250,
      );
      await cancellable(
        new Promise((resolve) => {
          timer = setTimeout(resolve, seconds * 1000);
        }),
        signal,
      );
      const samples = resample(concatFloat32(chunks), context.sampleRate, TARGET_RATE);
      if (samples.length < TARGET_RATE * 5)
        throw new Error('The recording was too short. Please try again.');
      const rms = Math.sqrt(
        samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
      );
      if (rms < 0.003)
        throw new Error('The sample is too quiet. Move closer and speak throughout the recording.');
      return wav16(samples, TARGET_RATE);
    } finally {
      clearTimeout(timer);
      clearInterval(interval);
      try {
        processor?.disconnect();
      } catch (_) {}
      try {
        source?.disconnect();
      } catch (_) {}
      stream?.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => {});
    }
  }
  const enroll = () => saveProfile(false);
  async function saveProfile(nameOnly) {
    if (busy || !validName() || !signedIn() || !providerIsSynap()) return;
    if (!nameOnly && (!$('#synapVoiceConsent').checked || capturing())) return;
    const name = $('#synapVoiceName').value.trim(),
      key = accountKey();
    const controller = new AbortController();
    operation = controller;
    ++refreshVersion;
    busy = true;
    render();
    updateControls();
    const error = $('#synapVoiceError'),
      count = $('#synapVoiceCountdown'),
      prompt = $('#synapVoicePrompt');
    error.hidden = true;
    try {
      let options;
      if (nameOnly) {
        prompt.textContent = 'Saving your name…';
        options = {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: name }),
        };
      } else {
        prompt.textContent = 'Speak naturally. Describe your day or plans in your usual language.';
        const audio = await capture(
          RECORD_SECONDS,
          (remaining) => {
            count.textContent = remaining + 's';
          },
          controller.signal,
        );
        prompt.textContent = 'Creating encrypted voice profile…';
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav', 'X-Synap-Voice-Name': encodeURIComponent(name) },
          body: audio,
        };
      }
      if (controller.signal.aborted || key !== accountKey()) throw abortError();
      const saved = await request('/v1/voice-profile', { ...options, signal: controller.signal });
      if (controller.signal.aborted || key !== accountKey()) throw abortError();
      status = saved;
      count.textContent = '✓';
      prompt.textContent = nameOnly
        ? 'Name saved for new memories.'
        : 'Voice profile ready for new memories.';
      root.dispatchEvent(new CustomEvent('synap-voice-profile-updated'));
      closeDialog();
    } catch (errorValue) {
      if (errorValue.name !== 'AbortError' && key === accountKey()) {
        error.textContent = errorValue.message || 'Could not save voice profile.';
        error.hidden = false;
        count.textContent = RECORD_SECONDS + 's';
        prompt.textContent = 'You can try again. Your previous profile is unchanged.';
      }
    } finally {
      if (operation === controller) {
        operation = null;
        busy = false;
        updateControls();
        render();
        if (key !== accountKey()) void refresh();
      }
    }
  }
  async function deleteProfile() {
    if (busy || !status?.enrolled) return;
    if (
      !root.confirm(
        'Delete your voice profile? Future memories will stop identifying your speech as You.',
      )
    )
      return;
    busy = true;
    const key = accountKey();
    ++refreshVersion;
    render();
    try {
      await request('/v1/voice-profile', { method: 'DELETE' });
      if (key !== accountKey()) return;
      status = {
        ...status,
        enrolled: false,
        displayName: null,
        model: null,
        createdAt: null,
        updatedAt: null,
      };
      render();
    } catch (e) {
      const detail = $('#synapVoiceProfileStatus');
      if (detail) detail.textContent = e.message || 'Could not delete voice profile.';
    } finally {
      busy = false;
      render();
    }
  }
  async function refresh() {
    style();
    row();
    const key = accountKey();
    if (key !== scope || !providerIsSynap()) {
      closeDialog();
      status = null;
      scope = key;
    }
    const version = ++refreshVersion;
    if (!key || !providerIsSynap()) {
      status = null;
      render();
      return;
    }
    if (busy) return;
    try {
      const next = await request('/v1/voice-profile');
      if (version !== refreshVersion || key !== accountKey()) return;
      status = next;
    } catch (e) {
      if (version !== refreshVersion || key !== accountKey()) return;
      if (e?.status === 404) {
        status = {
          available: false,
          enrolled: false,
          error: 'Could not check your voice profile. Reopen Settings to retry.',
        };
      } else {
        status = { available: false, enrolled: false };
        console.warn('[synap voice] status failed', e);
      }
    }
    render();
  }
  function bind() {
    style();
    row();
    if (root.SynapAuth?.onChange) root.SynapAuth.onChange(() => setTimeout(refresh, 0));
    $('#providerInput')?.addEventListener('change', () => setTimeout(refresh, 0));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
    });
    refresh();
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  root.SynapVoiceProfile = {
    refresh,
    get status() {
      return status;
    },
  };
})(globalThis);
