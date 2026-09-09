/* Hardware recording bridge.
 *
 * A user recording must stay one recording. This bridge adopts a hardware-
 * initiated stream into the browser journal and coordinates intentional sleep,
 * but it never stops/restarts a live capture to manufacture local "Part N"
 * files. Rolling 30-second AI windows remain internal to audio-store.js.
 */
(function (root) {
  'use strict';

  const ROLLOVER_MS = 0; // Synthetic file rollover is intentionally disabled.
  const LEGACY_SESSION_KEY = 'synap-continuous-capture';
  const AUTO_RECONNECT_KEY = 'dk-pendant-auto-reconnect';
  const POWER_EVENT_MAGIC = 0xE2;
  const POWER_EVENT_VERSION = 1;
  const POWER_STATE_DEEP_SLEEP = 3;
  const SLEEP_RECONNECT_GUARD_MS = 1500;

  let startingFromHardware = false;
  let hardwareAdoptTimer = null;
  let intentionalSleep = false;
  let reconnectPreferenceBeforeSleep = null;
  let reconnectPreferenceExisted = false;
  let reconnectRestoreTimer = null;

  function clearLegacyContinuousSession() {
    try { root.sessionStorage?.removeItem(LEGACY_SESSION_KEY); } catch (_) {}
  }

  /* Compatibility surfaces retained for older callers. There is deliberately no
     active continuous-part session anymore. */
  function readSession() { return null; }
  function patchJournal() { return false; }

  function clearHardwareAdoptTimer() {
    if (hardwareAdoptTimer) root.clearInterval(hardwareAdoptTimer);
    hardwareAdoptTimer = null;
  }

  function clearReconnectRestoreTimer() {
    if (reconnectRestoreTimer) root.clearTimeout(reconnectRestoreTimer);
    reconnectRestoreTimer = null;
  }

  function parseHex(hex) {
    return String(hex || '').trim().split(/\s+/).filter(Boolean).map(value => Number.parseInt(value, 16));
  }

  function beginIntentionalSleep() {
    if (intentionalSleep) return;
    intentionalSleep = true;
    clearReconnectRestoreTimer();
    clearHardwareAdoptTimer();
    startingFromHardware = false;
    try {
      reconnectPreferenceBeforeSleep = root.localStorage?.getItem(AUTO_RECONNECT_KEY) ?? null;
      reconnectPreferenceExisted = reconnectPreferenceBeforeSleep !== null;
      root.localStorage?.setItem(AUTO_RECONNECT_KEY, 'off');
    } catch (_) {
      reconnectPreferenceBeforeSleep = null;
      reconnectPreferenceExisted = false;
    }
    if (document.body) {
      document.body.dataset.intentionalSleep = '1';
      document.body.dataset.powerState = 'deep-sleep';
    }
    root.dispatchEvent(new CustomEvent('synap-intentional-sleep', {detail:{active:true}}));
  }

  function endIntentionalSleep() {
    if (!intentionalSleep) return;
    clearReconnectRestoreTimer();
    try {
      if (reconnectPreferenceExisted) root.localStorage?.setItem(AUTO_RECONNECT_KEY, reconnectPreferenceBeforeSleep);
      else root.localStorage?.removeItem(AUTO_RECONNECT_KEY);
    } catch (_) {}
    intentionalSleep = false;
    reconnectPreferenceBeforeSleep = null;
    reconnectPreferenceExisted = false;
    if (document.body) delete document.body.dataset.intentionalSleep;
    root.dispatchEvent(new CustomEvent('synap-intentional-sleep', {detail:{active:false}}));
  }

  function scheduleReconnectPreferenceRestore() {
    if (!intentionalSleep || reconnectRestoreTimer) return;
    reconnectRestoreTimer = root.setTimeout(() => {
      reconnectRestoreTimer = null;
      if (document.body?.dataset?.deviceState === '0' || document.body?.dataset?.state === 'disconnected') {
        endIntentionalSleep();
      }
    }, SLEEP_RECONNECT_GUARD_MS);
  }

  function handlePowerEvent(event) {
    const bytes = parseHex(event?.detail?.hex);
    if (bytes.length !== 6 || bytes[0] !== POWER_EVENT_MAGIC || bytes[1] !== POWER_EVENT_VERSION) return;
    if (bytes[2] === POWER_STATE_DEEP_SLEEP) beginIntentionalSleep();
  }

  /* A physical double-tap can put firmware into STREAMING before app.js has an
     open journal. Adopt that same stream by invoking Start once; firmware START
     is idempotent, so this opens browser storage without creating a second
     transport stream. */
  function adoptHardwareStream() {
    if (startingFromHardware || hardwareAdoptTimer || intentionalSleep) return;
    startingFromHardware = true;
    let attempts = 0;
    hardwareAdoptTimer = root.setInterval(() => {
      if (document.body.dataset.deviceState !== '2') {
        clearHardwareAdoptTimer();
        startingFromHardware = false;
        return;
      }
      const start = document.getElementById('startButton');
      if (start && !start.disabled) {
        clearHardwareAdoptTimer();
        start.click();
        startingFromHardware = false;
        return;
      }
      if (++attempts >= 40) {
        clearHardwareAdoptTimer();
        startingFromHardware = false;
      }
    }, 50);
  }

  function handleDeviceState() {
    const state = document.body.dataset.deviceState;
    if (state === '2') {
      clearReconnectRestoreTimer();
      if (!intentionalSleep) adoptHardwareStream();
      return;
    }

    clearHardwareAdoptTimer();
    startingFromHardware = false;
    if (state === '1') {
      clearReconnectRestoreTimer();
      if (intentionalSleep && !root.SynapSleepStateGuard) endIntentionalSleep();
      return;
    }
    if (intentionalSleep && !root.SynapSleepStateGuard) scheduleReconnectPreferenceRestore();
  }

  function improveCopy() {
    const pipeline = document.querySelectorAll('.pipeline li');
    if (pipeline.length >= 3) {
      pipeline[0].innerHTML = '<span>01</span> Transcribe';
      pipeline[1].innerHTML = '<span>02</span> Build context';
      pipeline[2].innerHTML = '<span>03</span> Create meeting notes';
    }
    const key = document.querySelector('.led-key');
    if (key && !document.getElementById('touchControlHint')) {
      const hint = document.createElement('span');
      hint.id = 'touchControlHint';
      hint.textContent = 'Touch: double tap to start/stop · triple tap to sleep/wake';
      key.appendChild(hint);
    }
  }

  function bind() {
    clearLegacyContinuousSession();
    improveCopy();
    if (!root.SynapSleepStateGuard) root.addEventListener('synap-event-packet', handlePowerEvent);
    root.addEventListener('synap-intentional-sleep', event => {
      intentionalSleep = Boolean(event?.detail?.active);
      if (intentionalSleep) {
        clearReconnectRestoreTimer();
        clearHardwareAdoptTimer();
        startingFromHardware = false;
      } else {
        handleDeviceState();
      }
    });
    root.addEventListener('synap-gatt-service-ready', () => {
      if (intentionalSleep && !root.SynapSleepStateGuard) endIntentionalSleep();
    });
    if (!root.SynapSleepStateGuard) root.addEventListener('pagehide', () => {
      if (intentionalSleep && !root.SynapSleepStateGuard) endIntentionalSleep();
    });
    const observer = new MutationObserver(handleDeviceState);
    observer.observe(document.body, {attributes:true, attributeFilter:['data-device-state','data-state']});
    handleDeviceState();
  }

  root.SynapRecordingBridge = {
    ROLLOVER_MS,
    SPLIT_RECORDINGS: false,
    SLEEP_RECONNECT_GUARD_MS,
    readSession,
    patchJournal,
    get intentionalSleep() { return intentionalSleep; },
    beginIntentionalSleep,
    endIntentionalSleep
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, {once:true});
  else bind();
})(globalThis);
