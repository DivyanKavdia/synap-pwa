/* Capture stability guards for Synap PWA.
 *
 * Product invariant: one user recording is one local recording. Transport
 * recovery must never synthesize an extra Start click or a "Part N" recording.
 *
 * This module only normalizes the firmware's 16-bit frame counter for durable
 * browser storage and hides low-level recovery controls. The core recorder owns
 * all start/stop/reconnect decisions.
 */
(function (root) {
  'use strict';

  const LEGACY_CONTINUOUS_KEY = 'synap-continuous-capture';
  const sequenceStates = new Map();

  function stateFor(recordingId, rawSequence) {
    const id = String(recordingId || '');
    if (!id) return null;
    let state = sequenceStates.get(id);
    if (!state) {
      state = {
        lastRaw: Number(rawSequence),
        lastLogical: 0,
        pendingBase: null
      };
      sequenceStates.set(id, state);
    }
    return state;
  }

  /* Convert the firmware's uint16 sequence into a monotonically increasing
     recording-relative sequence. This safely unwraps 65535 -> 0 instead of
     overwriting the first frames of a long take. Duplicate chunks for the same
     frame map to the same logical sequence. */
  function relativeSequence(recordingId, rawSequence) {
    const id = String(recordingId || '');
    const raw = Number(rawSequence);
    if (!id || !Number.isInteger(raw) || raw < 0 || raw > 0xffff) return rawSequence;

    const existing = sequenceStates.get(id);
    if (!existing) {
      stateFor(id, raw);
      return 0;
    }

    if (Number.isInteger(existing.pendingBase)) {
      existing.lastRaw = raw;
      existing.lastLogical = existing.pendingBase;
      existing.pendingBase = null;
      return existing.lastLogical;
    }

    if (raw === existing.lastRaw) return existing.lastLogical;

    const forward = (raw - existing.lastRaw + 0x10000) & 0xffff;
    if (forward > 0 && forward < 0x8000) {
      existing.lastRaw = raw;
      existing.lastLogical += forward;
      return existing.lastLogical;
    }

    /* A late/out-of-order packet should map backwards without moving the live
       cursor. Web Bluetooth notifications are ordered, but this keeps storage
       deterministic if an old packet is delivered during teardown. */
    const backward = (existing.lastRaw - raw + 0x10000) & 0xffff;
    return Math.max(0, existing.lastLogical - backward);
  }

  /* Compatibility hook for a future same-recording transport resume. Calling
     this before the first frame of a new firmware stream makes that frame follow
     the existing recording instead of reusing sequence zero. gapFrames may be
     used to preserve a real-time silence gap. It does not create another file. */
  function beginTransportEpoch(recordingId, gapFrames = 0) {
    const state = sequenceStates.get(String(recordingId || ''));
    if (!state) return false;
    const gap = Math.max(0, Math.floor(Number(gapFrames) || 0));
    state.pendingBase = state.lastLogical + 1 + gap;
    return true;
  }

  function forgetSequence(recordingId) {
    sequenceStates.delete(String(recordingId || ''));
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

  function clearLegacyContinuousSession() {
    try { root.sessionStorage?.removeItem(LEGACY_CONTINUOUS_KEY); } catch (_) {}
  }

  function hideLowLevelRecoveryUi() {
    const styleId = 'synap-hide-low-level-recovery';
    if (!root.document?.getElementById?.(styleId)) {
      const style = root.document.createElement('style');
      style.id = styleId;
      style.textContent = '#advancedSettings,.product-advanced,#retrySaveButton,#recoveryButton,#runQueueButton,#pauseQueueButton{display:none!important}';
      root.document.head?.appendChild(style);
    }
    ['retrySaveButton','recoveryButton','runQueueButton','pauseQueueButton'].forEach(id => {
      const node = root.document?.getElementById?.(id);
      if (node) {
        node.hidden = true;
        node.setAttribute('aria-hidden', 'true');
      }
    });
  }

  function init() {
    clearLegacyContinuousSession();
    hideLowLevelRecoveryUi();
  }

  ensureJournalPatch();
  if (root.document?.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  root.SynapCaptureStability = Object.freeze({
    relativeSequence,
    beginTransportEpoch,
    forgetSequence,
    patchJournalSequences
  });
})(globalThis);
