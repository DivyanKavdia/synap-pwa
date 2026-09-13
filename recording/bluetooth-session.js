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
    }

    reset() {
      this.generation++;
      this.pending = Promise.resolve();
    }

    run(action, label = 'Bluetooth operation') {
      const owner = this.connection(),
        generation = this.generation;
      let expired = false,
        started = false;
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
        const result = await action();
        if (!current()) throw new Error('Bluetooth connection changed.');
        return result;
      });
      // A caller deadline cannot cancel a browser ATT request. Keep the native
      // promise as the queue owner until it settles or the connection resets.
      this.pending = operation.catch(() => {});
      return this.withTimeout(operation, this.timeoutMs, label).catch((error) => {
        expired = true;
        this.onFailure(error, { label, owner, started, current: current() });
        throw error;
      });
    }
  }

  root.SynapBluetoothSession = BluetoothSession;
})(globalThis);
