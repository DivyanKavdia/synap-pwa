/* Capture continuity guards for Synap PWA.
 *
 * Two production invariants live here:
 * 1) Firmware frame sequence numbers are transport-global. The browser journal
 *    must store them relative to each recording or a take that starts at a
 *    non-zero sequence is padded with silence from sequence zero.
 * 2) Web Bluetooth links can drop while the pendant remains healthy. Keep
 *    retrying a remembered GATT handle and, when a drop interrupted an active
 *    capture, automatically continue into the next local part after reconnect.
 *
 * No firmware behavior is changed. Audio that was transmitted while the BLE
 * link was actually down cannot be recovered, but audio before and after the
 * interruption stays truthful and playable instead of becoming a long silent
 * WAV.
 */
(function (root) {
  'use strict';

  const AUTO_RECONNECT_KEY = 'dk-pendant-auto-reconnect';
  const CONTINUOUS_KEY = 'synap-continuous-capture';
  const RECONNECT_LABEL = /reconnect/i;
  const RETRY_DELAYS = [700, 1200, 2200, 4000, 7000, 10000];
  const RESUME_WINDOW_MS = 2 * 60 * 1000;

  const sequenceStarts = new Map();

  function relativeSequence(recordingId, rawSequence) {
    const id = String(recordingId || '');
    const raw = Number(rawSequence);
    if (!id || !Number.isInteger(raw) || raw < 0 || raw > 0xffff) return rawSequence;
    if (!sequenceStarts.has(id)) sequenceStarts.set(id, raw);
    return (raw - sequenceStarts.get(id) + 0x10000) & 0xffff;
  }

  function forgetSequence(recordingId) {
    sequenceStarts.delete(String(recordingId || ''));
  }

  function patchJournalSequences() {
    const Store = root.DKAudioStore;
    if (!Store || Store.prototype.__synapRelativeSequencePatched) return false;
    const proto = Store.prototype;
    const originalAppend = proto.append;
    const originalClose = proto.close;
    const originalRemove = proto.remove;

    proto.append = function (recordingId, packet) {
      if (!packet || !Number.isInteger(Number(packet.sequence))) {
        return originalAppend.call(this, recordingId, packet);
      }
      const normalized = Object.assign({}, packet, {
        sequence: relativeSequence(recordingId, Number(packet.sequence))
      });
      return originalAppend.call(this, recordingId, normalized);
    };

    proto.close = async function (recordingId) {
      try {
        return await originalClose.apply(this, arguments);
      } finally {
        forgetSequence(recordingId);
      }
    };

    if (typeof originalRemove === 'function') {
      proto.remove = async function (recordingId) {
        try {
          return await originalRemove.apply(this, arguments);
        } finally {
          forgetSequence(recordingId);
        }
      };
    }

    proto.__synapRelativeSequencePatched = true;
    return true;
  }

  function ensureJournalPatch() {
    if (patchJournalSequences()) return;
    let attempts = 0;
    const timer = root.setInterval(function () {
      attempts += 1;
      if (patchJournalSequences() || attempts >= 100) root.clearInterval(timer);
    }, 25);
  }

  function autoReconnectEnabled() {
    try { return root.localStorage?.getItem(AUTO_RECONNECT_KEY) !== 'off'; }
    catch (_) { return true; }
  }

  function intentionalSleep() {
    return root.document?.body?.dataset?.intentionalSleep === '1';
  }

  function connectionLabel() {
    return String(root.document?.getElementById('connectButtonLabel')?.textContent || '');
  }

  function canUseRememberedReconnect() {
    const button = root.document?.getElementById('connectButton');
    return Boolean(button && !button.disabled && RECONNECT_LABEL.test(connectionLabel()));
  }

  function readContinuousSession() {
    try { return JSON.parse(root.sessionStorage?.getItem(CONTINUOUS_KEY) || 'null'); }
    catch (_) { return null; }
  }

  function advanceContinuousPart() {
    try {
      const value = readContinuousSession();
      if (!value || typeof value !== 'object') return false;
      value.part = Math.max(1, Number(value.part) || 1) + 1;
      root.sessionStorage?.setItem(CONTINUOUS_KEY, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function bindReconnectContinuity() {
    const body = root.document?.body;
    const connect = root.document?.getElementById('connectButton');
    const start = root.document?.getElementById('startButton');
    const stop = root.document?.getElementById('stopButton');
    if (!body || !connect || !start) return false;

    let captureActive = false;
    let resumePending = false;
    let resumeUntil = 0;
    let resumeStartAt = 0;
    let retryIndex = 0;
    let retryTimer = 0;
    let manualSuppressUntil = 0;

    function clearRetry() {
      if (retryTimer) root.clearTimeout(retryTimer);
      retryTimer = 0;
    }

    function clearResume() {
      resumePending = false;
      resumeUntil = 0;
      resumeStartAt = 0;
    }

    function scheduleReconnect(delay) {
      if (retryTimer || !autoReconnectEnabled() || intentionalSleep()) return;
      if (Date.now() < manualSuppressUntil) return;
      const chosen = Number.isFinite(delay) ? delay : RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
      retryTimer = root.setTimeout(function () {
        retryTimer = 0;
        if (root.document?.visibilityState === 'hidden') return;
        if (body.dataset.state !== 'disconnected' || !autoReconnectEnabled() || intentionalSleep()) return;
        if (!canUseRememberedReconnect()) {
          // A restored Web Bluetooth handle may become available shortly after
          // page lifecycle recovery. Re-check; never invoke a permission chooser.
          retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS.length - 1);
          scheduleReconnect();
          return;
        }
        retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS.length - 1);
        connect.click();
        scheduleReconnect(RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)]);
      }, Math.max(0, chosen));
    }

    function maybeResumeCapture() {
      if (!resumePending || Date.now() > resumeUntil || intentionalSleep()) {
        if (resumePending && Date.now() > resumeUntil) clearResume();
        return;
      }
      if (body.dataset.state !== 'idle' || body.dataset.deviceState !== '1' || start.disabled) return;
      if (resumeStartAt && Date.now() - resumeStartAt < 3500) return;
      resumeStartAt = Date.now();
      advanceContinuousPart();
      start.click();
    }

    function sync() {
      const state = String(body.dataset.state || '');

      if (state === 'starting' || state === 'recording') captureActive = true;
      if (state === 'recording') {
        retryIndex = 0;
        clearRetry();
        if (resumePending) clearResume();
        return;
      }

      if (state === 'disconnected') {
        if (captureActive && !intentionalSleep() && Date.now() >= manualSuppressUntil) {
          resumePending = true;
          resumeUntil = Date.now() + RESUME_WINDOW_MS;
          resumeStartAt = 0;
        }
        captureActive = false;
        if (Date.now() >= manualSuppressUntil) scheduleReconnect(350);
        return;
      }

      if (state === 'idle') {
        retryIndex = 0;
        clearRetry();
        maybeResumeCapture();
      }
    }

    // A deliberate Stop must never be interpreted as a transport interruption.
    stop?.addEventListener('click', function () {
      captureActive = false;
      clearResume();
    }, true);

    // Clicking the connected device summary is the explicit disconnect action.
    connect.addEventListener('click', function () {
      const state = String(body.dataset.state || '');
      if (state === 'idle' && /disconnect/i.test(connectionLabel())) {
        manualSuppressUntil = Date.now() + 8000;
        captureActive = false;
        clearResume();
        clearRetry();
      }
    }, true);

    root.addEventListener?.('synap-intentional-sleep', function (event) {
      if (event?.detail?.active) {
        captureActive = false;
        clearResume();
        clearRetry();
      }
    });

    root.document?.addEventListener('visibilitychange', function () {
      if (root.document.visibilityState === 'visible' && body.dataset.state === 'disconnected') {
        scheduleReconnect(100);
      }
    });

    const observer = new MutationObserver(sync);
    observer.observe(body, { attributes: true, attributeFilter: ['data-state', 'data-device-state', 'data-intentional-sleep'] });
    sync();
    return true;
  }

  function hideLowLevelRecoveryUi() {
    const styleId = 'synap-hide-low-level-recovery';
    if (!root.document?.getElementById(styleId)) {
      const style = root.document.createElement('style');
      style.id = styleId;
      style.textContent = '#advancedSettings,.product-advanced,#retrySaveButton,#recoveryButton,#runQueueButton,#pauseQueueButton{display:none!important}';
      root.document.head?.appendChild(style);
    }

    // Older cached product-ui.js can create the wrapper after this module loads.
    const removeWrapper = function () {
      root.document?.querySelectorAll?.('#advancedSettings,.product-advanced').forEach(function (node) {
        node.hidden = true;
        node.setAttribute('aria-hidden', 'true');
      });
    };
    removeWrapper();
    if (root.MutationObserver && root.document?.body) {
      new MutationObserver(removeWrapper).observe(root.document.body, { childList: true, subtree: true });
    }
  }

  function init() {
    hideLowLevelRecoveryUi();
    bindReconnectContinuity();
  }

  ensureJournalPatch();
  if (root.document?.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  root.SynapCaptureStability = Object.freeze({
    relativeSequence,
    forgetSequence,
    patchJournalSequences,
    readContinuousSession,
    advanceContinuousPart,
    RESUME_WINDOW_MS
  });
})(globalThis);
