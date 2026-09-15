/* One owner for native ATT work. Recording and UI policy belong to the caller. */
(function (root) {
  'use strict';

  class BluetoothSession {
    constructor({ connection, connected, withTimeout, timeoutMs, onFailure = () => {} }) {
      this.connection = connection;
      this.connected = connected;
      this.withTimeout = withTimeout;
      this.timeoutMs = timeoutMs;
      this.onFailure = onFailure;
      this.pending = Promise.resolve();
      this.generation = 0;
      this.active = null;
    }

    reset() {
      this.generation++;
      this.pending = Promise.resolve();
      this.active = null;
    }

    run(action, label = 'Bluetooth operation') {
      const owner = this.connection(),
        generation = this.generation;
      let expired = false,
        started = false;
      let begin;
      const ready = new Promise((resolve) => {
        begin = resolve;
      });
      const entry = { label, owner };
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
        if (expired) return;
        if (!current()) throw new Error('Bluetooth connection changed.');
        started = true;
        this.active = entry;
        begin();
        try {
          const result = await action();
          if (!current()) throw new Error('Bluetooth connection changed.');
          return result;
        } finally {
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
        this.timeoutMs,
        label + ' waiting for Bluetooth',
      )
        .then(() => this.withTimeout(operation, this.timeoutMs, label))
        .catch((error) => {
          expired = true;
          this.onFailure(error, {
            label,
            owner,
            started,
            current: current(),
            blockedBy: !started ? this.active?.label : undefined,
          });
          throw error;
        });
    }
  }

  root.SynapBluetoothSession = BluetoothSession;
})(globalThis);
