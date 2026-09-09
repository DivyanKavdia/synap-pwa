/* Hardware recording bridge and long-capture rollover. */
(function (root) {
  'use strict';

  const ROLLOVER_MS = 45 * 60 * 1000;
  const SESSION_KEY = 'synap-continuous-capture';
  const AUTO_RECONNECT_KEY = 'dk-pendant-auto-reconnect';
  const POWER_EVENT_MAGIC = 0xE2;
  const POWER_EVENT_VERSION = 1;
  const POWER_STATE_DEEP_SLEEP = 3;
  const SLEEP_RECONNECT_GUARD_MS = 1500;
  let activeSince = 0;
  let rolloverTimer = null;
  let rolloverPending = false;
  let startingFromHardware = false;
  let hardwareAdoptTimer = null;
  let intentionalSleep = false;
  let reconnectPreferenceBeforeSleep = null;
  let reconnectPreferenceExisted = false;
  let reconnectRestoreTimer = null;

  function readSession() {
    try { return JSON.parse(root.sessionStorage?.getItem(SESSION_KEY) || 'null'); }
    catch (_) { return null; }
  }

  function writeSession(value) {
    try {
      if (value) root.sessionStorage?.setItem(SESSION_KEY, JSON.stringify(value));
      else root.sessionStorage?.removeItem(SESSION_KEY);
    } catch (_) {}
  }

  function newGroup() {
    return {
      id: root.crypto?.randomUUID?.() || ('continuous-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
      part: 1,
      startedAt: new Date().toISOString()
    };
  }

  function patchJournal() {
    const Store = root.DKAudioStore;
    if (!Store || Store.prototype.__synapContinuousPatched) return false;
    const original = Store.prototype.begin;
    Store.prototype.begin = async function (name, association) {
      let session = readSession();
      if (!session) { session = newGroup(); writeSession(session); }
      const part = Math.max(1, Number(session.part) || 1);
      const displayName = part > 1 ? name + ' · Part ' + part : name;
      const id = await original.call(this, displayName, association);
      await this.atomic(['recordings'], stores => {
        const request = stores.recordings.get(id);
        request.onsuccess = () => {
          if (!request.result) return;
          stores.recordings.put({
            ...request.result,
            continuousGroupId: session.id,
            continuousPart: part,
            continuousStartedAt: session.startedAt,
            captureMode: part > 1 ? 'continuous-part' : 'meeting-or-continuous'
          });
        };
      });
      return id;
    };
    Store.prototype.__synapContinuousPatched = true;
    return true;
  }

  function ensureJournalPatch() {
    if (patchJournal()) return;
    let attempts = 0;
    const timer = root.setInterval(() => {
      if (patchJournal() || ++attempts > 100) root.clearInterval(timer);
    }, 50);
  }

  function clearRolloverTimer() {
    if (rolloverTimer) root.clearTimeout(rolloverTimer);
    rolloverTimer = null;
  }

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
    clearRolloverTimer();
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

  function scheduleRollover() {
    clearRolloverTimer();
    if (!activeSince) activeSince = performance.now();
    const remaining = Math.max(500, ROLLOVER_MS - (performance.now() - activeSince));
    rolloverTimer = root.setTimeout(() => {
      const stop = document.getElementById('stopButton');
      if (!stop || stop.disabled || document.body.dataset.deviceState !== '2') return;
      rolloverPending = true;
      stop.click();
    }, remaining);
  }

  function beginNextPartWhenReady() {
    let attempts = 0;
    const poll = root.setInterval(() => {
      const start = document.getElementById('startButton');
      if (start && !start.disabled && document.body.dataset.deviceState === '1') {
        root.clearInterval(poll);
        let session = readSession() || newGroup();
        session.part = Math.max(1, Number(session.part) || 1) + 1;
        writeSession(session);
        rolloverPending = false;
        activeSince = 0;
        start.click();
      } else if (++attempts > 120) {
        root.clearInterval(poll);
        rolloverPending = false;
      }
    }, 100);
  }

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
      if (intentionalSleep) return;
      adoptHardwareStream();
      if (!activeSince) activeSince = performance.now();
      scheduleRollover();
      return;
    }

    clearHardwareAdoptTimer();
    startingFromHardware = false;
    clearRolloverTimer();
    activeSince = 0;
    if (state === '1') {
      clearReconnectRestoreTimer();
      if (intentionalSleep) endIntentionalSleep();
      if (rolloverPending) beginNextPartWhenReady();
      else root.setTimeout(() => {
        if (!rolloverPending && document.body.dataset.deviceState === '1') writeSession(null);
      }, 1200);
      return;
    }
    if (intentionalSleep) scheduleReconnectPreferenceRestore();
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
    ensureJournalPatch();
    improveCopy();
    if(!root.SynapSleepStateGuard) root.addEventListener('synap-event-packet', handlePowerEvent);
    root.addEventListener('synap-intentional-sleep', event => {
      intentionalSleep=Boolean(event?.detail?.active);
      if(intentionalSleep){clearReconnectRestoreTimer();clearRolloverTimer();clearHardwareAdoptTimer();startingFromHardware=false;}
      else handleDeviceState();
    });
    root.addEventListener('synap-gatt-service-ready', () => {
      if (intentionalSleep) endIntentionalSleep();
    });
    if(!root.SynapSleepStateGuard) root.addEventListener('pagehide', () => {
      if (intentionalSleep) endIntentionalSleep();
    });
    const observer = new MutationObserver(handleDeviceState);
    observer.observe(document.body, {attributes:true, attributeFilter:['data-device-state','data-state']});
    handleDeviceState();
  }

  root.SynapRecordingBridge = {
    ROLLOVER_MS,
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