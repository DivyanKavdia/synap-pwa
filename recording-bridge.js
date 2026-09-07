/* Hardware recording bridge and long-capture rollover. */
(function (root) {
  'use strict';

  const ROLLOVER_MS = 45 * 60 * 1000;
  const SESSION_KEY = 'synap-continuous-capture';
  let activeSince = 0;
  let rolloverTimer = null;
  let rolloverPending = false;
  let startingFromHardware = false;
  let hardwareAdoptTimer = null;

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
    if (startingFromHardware || hardwareAdoptTimer) return;
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
      if (rolloverPending) beginNextPartWhenReady();
      else root.setTimeout(() => {
        if (!rolloverPending && document.body.dataset.deviceState === '1') writeSession(null);
      }, 1200);
    }
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
      hint.textContent = 'Touch: double tap to start/stop · hold 5s to sleep · triple tap to wake';
      key.appendChild(hint);
    }
  }

  function bind() {
    ensureJournalPatch();
    improveCopy();
    const observer = new MutationObserver(handleDeviceState);
    observer.observe(document.body, {attributes:true, attributeFilter:['data-device-state']});
    handleDeviceState();
  }

  root.SynapRecordingBridge = { ROLLOVER_MS, readSession, patchJournal };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, {once:true});
  else bind();
})(globalThis);
