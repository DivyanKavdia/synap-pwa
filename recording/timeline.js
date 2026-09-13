/* A recording-relative clock for uint16 pendant counters, owned by one store. */
(function (root) {
  'use strict';
  class RecordingTimeline {
    constructor() {
      this.sequences = new Map();
    }
    timelineOffsetMs(recordingId) {
      return (this.sequences.get(String(recordingId))?.lastLogical || 0) * 50;
    }
    stateFor(recordingId, rawSequence) {
      const id = String(recordingId || '');
      if (!id) return null;
      let state = this.sequences.get(id);
      if (!state) {
        state = {
          lastRaw: Number(rawSequence),
          lastLogical: 0,
          pendingBase: null,
        };
        this.sequences.set(id, state);
      }
      return state;
    }

    /* Convert the firmware's uint16 sequence into a monotonically increasing
     recording-relative sequence. This safely unwraps 65535 -> 0 instead of
     overwriting the first frames of a long take. Duplicate chunks for the same
     frame map to the same logical sequence. */
    relativeSequence(recordingId, rawSequence) {
      const id = String(recordingId || '');
      const raw = Number(rawSequence);
      if (!id || !Number.isInteger(raw) || raw < 0 || raw > 0xffff) return rawSequence;

      const existing = this.sequences.get(id);
      if (!existing) {
        this.stateFor(id, raw);
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
      return existing.lastLogical - backward;
    }

    /* Continue the same journal after a firmware sequence restart on reconnect. */
    beginTransportEpoch(recordingId, gapFrames = 0) {
      const state = this.sequences.get(String(recordingId || ''));
      if (!state) return false;
      const gap = Math.max(0, Math.floor(Number(gapFrames) || 0));
      state.pendingBase = state.lastLogical + 1 + gap;
      return true;
    }

    forgetSequence(recordingId) {
      this.sequences.delete(String(recordingId || ''));
    }
  }
  root.SynapRecordingTimeline = RecordingTimeline;
})(globalThis);
