/* One owner for native ATT work. Recording and UI policy belong to the caller. */
(function (root) {
  'use strict';

  class BluetoothSession {
    static revision = '1.0.0-chakshu-core10';

    static normalizeError(reason) {
      if (reason && typeof reason.message === 'string') return reason;
      const message =
        typeof reason === 'string' && reason
          ? reason
          : reason?.description ||
            (reason?.code != null
              ? 'Bluetooth request failed (code ' + reason.code + ').'
              : 'Bluetooth request failed.');
      const error = new Error(message);
      // Some native bridges reject with a number, null or an undocumented
      // object. Retain bounded diagnostics instead of reducing all to Error.
      try {
        error.nativeReason = {
          type: typeof reason,
          value: String(reason).slice(0, 200),
          keys: reason && typeof reason === 'object' ? Object.keys(reason).slice(0, 12) : [],
        };
      } catch (_) {}
      if (reason?.name) error.name = reason.name;
      if (reason?.code != null) error.code = reason.code;
      return error;
    }

    constructor({ connection, connected, withTimeout, timeoutMs, onFailure = () => {}, onSlowOperation = () => {} }) {
      this.connection = connection;
      this.connected = connected;
      this.withTimeout = withTimeout;
      this.timeoutMs = timeoutMs;
      this.onFailure = onFailure;
      this.onSlowOperation = onSlowOperation;
      this.pending = Promise.resolve();
      this.generation = 0;
      this.active = null;
      this.entries = new Set();
    }

    reset() {
      this.generation++;
      this.pending = Promise.resolve();
      this.active = null;
      this.entries.clear();
    }

    run(action, label = 'Bluetooth operation', { timeoutMs = this.timeoutMs } = {}) {
      const owner = this.connection(),
        generation = this.generation;
      let expired = false,
        started = false;
      let begin;
      const ready = new Promise((resolve) => {
        begin = resolve;
      });
      const now = () => root.performance?.now() ?? Date.now();
      const entry = { label, owner, timeoutMs, startedAt: null, timedOut: false };
      // Several startup consumers enqueue in the same turn. Account for every
      // earlier request, including those that have not entered the bridge yet.
      // Each still gets its own native deadline; this is only the queue budget.
      const queuedAt = now();
      let aheadMs = 0;
      for (const earlier of this.entries) {
        aheadMs += earlier.startedAt === null ? earlier.timeoutMs :
          Math.max(0, earlier.timeoutMs - (queuedAt - earlier.startedAt));
      }
      const waitMs = Math.max(timeoutMs, aheadMs);
      this.entries.add(entry);
      const current = () => {
        const active = this.connection();
        return (
          generation === this.generation &&
          active.epoch === owner.epoch &&
          active.device === owner.device &&
          this.connected()
        );
      };
      const operation = this.pending.then(async () => {
        try {
          if (expired) return;
          if (!current()) throw new Error('Bluetooth connection changed.');
          started = true;
          entry.startedAt = now();
          this.active = entry;
          begin();
          const result = await action();
          if (!current()) throw new Error('Bluetooth connection changed.');
          const queuedMs = Math.round(entry.startedAt - queuedAt),
            nativeMs = Math.round(now() - entry.startedAt);
          if (queuedMs >= 1500 || nativeMs >= 1500)
            this.onSlowOperation({ operation: label, queuedMs, nativeMs });
          return result;
        } finally {
          this.entries.delete(entry);
          if (this.active === entry) this.active = null;
        }
      });
      // A caller deadline cannot cancel a browser ATT request. Keep the native
      // promise as the queue owner until it settles or the connection resets.
      this.pending = operation.catch(() => {});
      // Bound queue wait separately. Work that starts near the end of that wait
      // still needs its full native deadline, particularly camera reads.
      return this.withTimeout(
        Promise.race([ready, operation]),
        waitMs,
        label + ' waiting for Bluetooth',
      )
        .then(() => this.withTimeout(operation, timeoutMs, label))
        .catch((reason) => {
          const error = BluetoothSession.normalizeError(reason);
          expired = true;
          if (error.name === 'TimeoutError' && this.active === entry) entry.timedOut = true;
          this.onFailure(error, {
            label,
            owner,
            started,
            current: current(),
            blockedBy: !started ? this.active?.label : undefined,
            blockedByTimedOut: !started && Boolean(this.active?.timedOut),
          });
          throw error;
        });
    }
  }

  root.SynapBluetoothSession = BluetoothSession;
})(globalThis);
