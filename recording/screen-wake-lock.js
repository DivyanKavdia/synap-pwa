/* Optional screen-awake requests must never hold recording or OTA open. */
(function (root) {
  'use strict';

  class ScreenWakeLock {
    constructor({ navigator, scope, log = () => {}, timeoutMs = 1500, timers = root }) {
      Object.assign(this, { navigator, scope, log, timeoutMs, timers });
      this.owner = null;
    }

    current(owner) {
      return this.owner === owner && this.scope() === owner.scope;
    }

    async bounded(request) {
      let timer;
      try {
        return await Promise.race([
          request,
          new Promise((_, reject) => {
            timer = this.timers.setTimeout(() => reject(Error('Screen-awake request timed out.')), this.timeoutMs);
          }),
        ]);
      } finally {
        this.timers.clearTimeout(timer);
      }
    }

    restoreBluefy(owner) {
      owner.bluefy = false;
      return this.bounded(Promise.resolve().then(() => {
        // A late reply from an old take must not dim a newer take's screen.
        if (!this.owner?.bluefy) return this.navigator.bluetooth.setScreenDimEnabled(true);
      })).catch(error => this.log('Bluefy screen control release failed', error));
    }

    releaseNative(lock) {
      return this.bounded(Promise.resolve().then(() => lock.release()))
        .catch(error => this.log('Wake lock release failed', error));
    }

    acquire() {
      const scope = this.scope();
      if (scope == null) return Promise.resolve();
      if (this.owner?.scope === scope) return this.owner.task;
      if (this.owner) void this.release();
      const owner = { scope, bluefy: false, lock: null, task: null };
      this.owner = owner;
      owner.task = this.obtain(owner).finally(() => {
        if (this.owner === owner && !owner.bluefy && !owner.lock) this.owner = null;
      });
      return owner.task;
    }

    async obtain(owner) {
      if (typeof this.navigator.bluetooth?.setScreenDimEnabled === 'function') {
        owner.bluefy = true;
        let sent = false;
        const request = Promise.resolve().then(() => {
          if (!this.current(owner)) return;
          sent = true;
          return this.navigator.bluetooth.setScreenDimEnabled(false);
        });
        request.then(() => {
          if (sent && !owner.bluefy) void this.restoreBluefy(owner);
        }, () => {});
        try {
          await this.bounded(request);
          if (this.current(owner)) this.log('Bluefy screen dimming disabled');
          else void this.restoreBluefy(owner);
          return;
        } catch (error) {
          this.log('Bluefy screen control unavailable', error);
          void this.restoreBluefy(owner);
        }
      }
      if (!this.current(owner) || typeof this.navigator.wakeLock?.request !== 'function') return;
      const request = Promise.resolve().then(() =>
        this.current(owner) ? this.navigator.wakeLock.request('screen') : null,
      ).then(lock => {
        if (!lock) return;
        if (!this.current(owner)) { void this.releaseNative(lock); return; }
        owner.lock = lock;
        lock.addEventListener('release', () => {
          if (owner.lock === lock) owner.lock = null;
          if (this.owner === owner) this.owner = null;
        });
      });
      try {
        await this.bounded(request);
        if (this.current(owner)) this.log('Screen wake lock acquired');
        else if (this.owner === owner) void this.release();
      } catch (error) {
        // Retire the request so a sentinel delivered after timeout is released.
        if (this.owner === owner) this.owner = null;
        if (owner.lock) {
          const lock = owner.lock;
          owner.lock = null;
          void this.releaseNative(lock);
        }
        this.log('Wake lock unavailable', error);
      }
    }

    release() {
      const owner = this.owner;
      this.owner = null;
      if (!owner) return Promise.resolve();
      const pending = [];
      if (owner.bluefy) pending.push(this.restoreBluefy(owner));
      if (owner.lock) {
        const lock = owner.lock;
        owner.lock = null;
        pending.push(this.releaseNative(lock));
      }
      return Promise.all(pending);
    }
  }

  root.SynapScreenWakeLock = ScreenWakeLock;
  if (typeof module !== 'undefined' && module.exports) module.exports = ScreenWakeLock;
})(globalThis);
