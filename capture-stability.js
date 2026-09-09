/* Capture continuity guards for Synap PWA.
 *
 * Responsibilities kept deliberately narrow:
 * 1) normalize firmware frame sequence numbers per local recording;
 * 2) remember that an active capture was interrupted and resume only after the
 *    core recorder has successfully reconnected;
 * 3) hide low-level recovery controls from product UI.
 *
 * Core app.js owns GATT reconnect scheduling. This module must never synthesize
 * extra Connect clicks because two independent reconnect loops can fight each
 * other and make the UI bounce between Connecting and Offline.
 */
(function (root) {
  'use strict';

  const CONTINUOUS_KEY = 'synap-continuous-capture';
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
    const start = root.document?.getElementById?.('startButton');
    const stop = root.document?.getElementById?.('stopButton');
    if (!body || !start) return false;

    let captureActive = false;
    let resumePending = false;
    let resumeUntil = 0;
    let resumeStarted = false;

    function clearResume() {
      resumePending = false;
      resumeUntil = 0;
      resumeStarted = false;
    }

    function maybeResume() {
      if (!resumePending || resumeStarted) return;
      if (Date.now() > resumeUntil) { clearResume(); return; }
      if (body.dataset.state !== 'idle' || body.dataset.deviceState !== '1' || start.disabled) return;
      resumeStarted = true;
      advanceContinuousPart();
      root.setTimeout(function () {
        if (body.dataset.state === 'idle' && !start.disabled) start.click();
        else resumeStarted = false;
      }, 350);
    }

    function sync() {
      const state = String(body.dataset.state || '');
      if (state === 'starting' || state === 'recording') captureActive = true;

      if (state === 'recording') {
        if (resumePending) clearResume();
        return;
      }

      if (state === 'disconnected') {
        if (captureActive) {
          resumePending = true;
          resumeUntil = Date.now() + RESUME_WINDOW_MS;
          resumeStarted = false;
        }
        captureActive = false;
        return;
      }

      if (state === 'idle') maybeResume();
    }

    stop?.addEventListener('click', function () {
      captureActive = false;
      clearResume();
    }, true);

    root.addEventListener?.('synap-intentional-sleep', function (event) {
      if (event?.detail?.active) {
        captureActive = false;
        clearResume();
      }
    });

    const observer = new MutationObserver(sync);
    observer.observe(body, {
      attributes: true,
      attributeFilter: ['data-state', 'data-device-state', 'data-intentional-sleep']
    });
    sync();
    return true;
  }

  function hideLowLevelRecoveryUi() {
    const styleId = 'synap-hide-low-level-recovery';
    if (!root.document?.getElementById?.(styleId)) {
      const style = root.document.createElement('style');
      style.id = styleId;
      style.textContent = '#advancedSettings,.product-advanced,#retrySaveButton,#recoveryButton,#runQueueButton,#pauseQueueButton{display:none!important}';
      root.document.head?.appendChild(style);
    }

    const hideWrapper = function () {
      root.document?.querySelectorAll?.('#advancedSettings,.product-advanced').forEach(function (node) {
        node.hidden = true;
        node.setAttribute('aria-hidden', 'true');
      });
    };
    hideWrapper();
    if (root.MutationObserver && root.document?.body) {
      new MutationObserver(hideWrapper).observe(root.document.body, { childList: true, subtree: true });
    }
  }

  function init() {
    hideLowLevelRecoveryUi();
    bindReconnectContinuity();
  }

  ensureJournalPatch();
  if (root.document?.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  root.SynapCaptureStability = Object.freeze({
    relativeSequence,
    forgetSequence,
    patchJournalSequences,
    readContinuousSession,
    advanceContinuousPart,
    RESUME_WINDOW_MS
  });
})(globalThis);
