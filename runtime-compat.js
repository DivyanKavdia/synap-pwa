/* Synap runtime compatibility guards.
 *
 * Some WebKit-hosted BLE browsers expose Web Bluetooth but not the Web Locks
 * API. app.js deliberately holds a page-lifetime lock before binding the main
 * UI, so a missing navigator.locks otherwise leaves Connect and Settings inert.
 *
 * Android Chrome also needs a tolerant Synap chooser filter. The main app uses
 * the custom 128-bit service UUID as the strongest discovery signal, but some
 * Android BLE stacks surface that UUID inconsistently between advertisement and
 * scan-response data. On Android only, we therefore add the known Synap device
 * name prefixes as OR filters while keeping the service UUID in optionalServices.
 * app.js still validates the real Synap primary service after GATT connection.
 *
 * This file provides only the tiny Web Locks subset Synap uses: an exclusive,
 * ifAvailable page lock. The fallback is backed by a best-effort localStorage
 * lease so two visible tabs do not normally claim the same pendant journal.
 */
(function (root) {
  'use strict';

  const navigatorObject = root.navigator;
  if (!navigatorObject) return;

  const SYNAP_SERVICE_UUID = '4fa12345-0000-1000-8000-00805f9b34fb';

  function installAndroidBluetoothDiscoveryFallback() {
    const bluetooth = navigatorObject.bluetooth;
    if (!bluetooth || typeof bluetooth.requestDevice !== 'function') return false;
    if (!/Android/i.test(String(navigatorObject.userAgent || ''))) return false;
    if (bluetooth.__synapDiscoveryCompatInstalled) return true;

    const nativeRequestDevice = bluetooth.requestDevice.bind(bluetooth);

    function hasSynapServiceFilter(options) {
      return Boolean(options && Array.isArray(options.filters) && options.filters.some(function (filter) {
        return filter && Array.isArray(filter.services) && filter.services.some(function (service) {
          return String(service).toLowerCase() === SYNAP_SERVICE_UUID;
        });
      }));
    }

    function addFilterOnce(filters, namePrefix) {
      if (!filters.some(function (filter) { return filter && filter.namePrefix === namePrefix; })) {
        filters.push({ namePrefix: namePrefix });
      }
    }

    function requestDevice(options) {
      if (!hasSynapServiceFilter(options) || options.acceptAllDevices) {
        return nativeRequestDevice(options);
      }

      const patched = Object.assign({}, options);
      patched.filters = options.filters.slice();
      // Filters in requestDevice are OR-ed. Keep the strong service match, then
      // add current and legacy Synap advertising names for Android discovery.
      addFilterOnce(patched.filters, 'synap');
      addFilterOnce(patched.filters, 'dk-');

      const optional = Array.isArray(options.optionalServices)
        ? options.optionalServices.slice()
        : [];
      if (!optional.some(function (service) {
        return String(service).toLowerCase() === SYNAP_SERVICE_UUID;
      })) {
        optional.push(SYNAP_SERVICE_UUID);
      }
      patched.optionalServices = optional;

      return nativeRequestDevice(patched);
    }

    try {
      Object.defineProperty(bluetooth, 'requestDevice', {
        configurable: true,
        writable: true,
        value: requestDevice
      });
      Object.defineProperty(bluetooth, '__synapDiscoveryCompatInstalled', {
        configurable: true,
        value: true
      });
      return bluetooth.requestDevice === requestDevice;
    } catch (_) {
      try {
        bluetooth.requestDevice = requestDevice;
        bluetooth.__synapDiscoveryCompatInstalled = true;
        return bluetooth.requestDevice === requestDevice;
      } catch (_) {
        return false;
      }
    }
  }

  function installWebLocksFallback() {
    if (navigatorObject.locks && typeof navigatorObject.locks.request === 'function') return;

    const PREFIX = 'synap-runtime-lock:';
    const OWNER = (root.crypto && typeof root.crypto.randomUUID === 'function')
      ? root.crypto.randomUUID()
      : String(Date.now()) + ':' + Math.random().toString(16).slice(2);
    const LEASE_MS = 15000;
    const HEARTBEAT_MS = 4000;

    function keyFor(name) {
      return PREFIX + String(name || 'lock');
    }

    function readLease(key) {
      try {
        const value = JSON.parse(root.localStorage.getItem(key) || 'null');
        if (!value || typeof value !== 'object') return null;
        return value;
      } catch (_) {
        return null;
      }
    }

    function writeLease(key) {
      try {
        root.localStorage.setItem(key, JSON.stringify({ owner: OWNER, expiresAt: Date.now() + LEASE_MS }));
        return true;
      } catch (_) {
        // Private/embedded runtimes may deny localStorage. Bluefy is effectively
        // single-page, so keep the app usable rather than failing before UI bind.
        return true;
      }
    }

    function acquire(key) {
      const lease = readLease(key);
      if (lease && lease.owner !== OWNER && Number(lease.expiresAt || 0) > Date.now()) return false;
      if (!writeLease(key)) return false;
      const confirmed = readLease(key);
      return !confirmed || confirmed.owner === OWNER;
    }

    function refresh(key) {
      const lease = readLease(key);
      if (lease && lease.owner !== OWNER && Number(lease.expiresAt || 0) > Date.now()) return false;
      return writeLease(key);
    }

    function release(key) {
      try {
        const lease = readLease(key);
        if (!lease || lease.owner === OWNER) root.localStorage.removeItem(key);
      } catch (_) {}
    }

    async function request(name, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      options = options || {};
      if (typeof callback !== 'function') throw new TypeError('Lock callback is required');

      const key = keyFor(name);
      let gotLock = acquire(key);

      if (!gotLock && !options.ifAvailable) {
        // Synap currently calls request() only with ifAvailable:true. Keep a
        // bounded compatibility path for any future accidental non-ifAvailable use.
        const deadline = Date.now() + LEASE_MS;
        while (!gotLock && Date.now() < deadline) {
          await new Promise(resolve => root.setTimeout(resolve, 250));
          gotLock = acquire(key);
        }
      }

      if (!gotLock) return callback(null);

      const lock = Object.freeze({ name: String(name), mode: 'exclusive' });
      const heartbeat = root.setInterval(function () { refresh(key); }, HEARTBEAT_MS);

      try {
        return await callback(lock);
      } finally {
        root.clearInterval(heartbeat);
        release(key);
      }
    }

    const fallback = Object.freeze({ request: request });
    try {
      Object.defineProperty(navigatorObject, 'locks', {
        configurable: true,
        enumerable: true,
        value: fallback
      });
    } catch (_) {
      try { navigatorObject.locks = fallback; } catch (_) {}
    }
  }

  function bindSettingsSafetyNet() {
    const settingsButton = root.document && root.document.getElementById('settingsButton');
    const closeButton = root.document && root.document.getElementById('closeSettingsButton');
    const dialog = root.document && root.document.getElementById('settingsDialog');
    if (!dialog) return;

    // Run after the normal app listener. If app.js is healthy, these are no-ops;
    // if initialization failed before bindEvents(), Settings remains accessible.
    if (settingsButton) settingsButton.addEventListener('click', function () {
      root.setTimeout(function () {
        if (dialog.open) return;
        try {
          if (typeof dialog.showModal === 'function') dialog.showModal();
          else dialog.setAttribute('open', '');
        } catch (_) {}
      }, 0);
    });

    if (closeButton) closeButton.addEventListener('click', function () {
      root.setTimeout(function () {
        if (!dialog.open && !dialog.hasAttribute('open')) return;
        try {
          if (typeof dialog.close === 'function') dialog.close();
          else dialog.removeAttribute('open');
        } catch (_) { dialog.removeAttribute('open'); }
      }, 0);
    });
  }

  const androidBleDiscoveryCompat = installAndroidBluetoothDiscoveryFallback();
  installWebLocksFallback();
  bindSettingsSafetyNet();

  root.SynapRuntimeCompat = Object.freeze({
    webLocksNative: Boolean(navigatorObject.locks && navigatorObject.locks.request && !String(navigatorObject.locks.request).includes('Lock callback is required')),
    androidBleDiscoveryCompat: androidBleDiscoveryCompat,
    installed: true
  });
})(globalThis);
