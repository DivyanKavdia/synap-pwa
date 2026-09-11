/* Synap runtime compatibility guards.
 *
 * Keep browser-compatibility concerns here: Web Locks fallback, Android BLE
 * discovery tolerance, managed-processing defaults, Settings safety, and lazy
 * source-audio hydration for Library cards. Product/capture state stays owned by
 * app.js.
 */
(function (root) {
  'use strict';

  const navigatorObject = root.navigator;
  if (!navigatorObject) return;

  const SYNAP_SERVICE_UUID = '4fa12345-0000-1000-8000-00805f9b34fb';
  const SYNAP_PROVIDER_KEY = 'synap-ai-provider-settings';
  const APP_SETTINGS_KEY = 'dk-pendant-settings';
  const CLOUD_PROCESSING_MIGRATION_KEY = 'synap-cloud-processing-default-v1';

  function readJson(key) {
    try {
      const value = JSON.parse(root.localStorage.getItem(key) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function bootstrapSynapProcessingPreferences() {
    try {
      const providerPrefs = readJson(SYNAP_PROVIDER_KEY);
      if (!providerPrefs.provider) {
        providerPrefs.provider = 'synap';
        root.localStorage.setItem(SYNAP_PROVIDER_KEY, JSON.stringify(providerPrefs));
      }
      if (providerPrefs.provider !== 'synap') return false;

      const appSettings = readJson(APP_SETTINGS_KEY);
      if (root.localStorage.getItem(CLOUD_PROCESSING_MIGRATION_KEY) !== '1') {
        appSettings.autoProcess = true;
        root.localStorage.setItem(CLOUD_PROCESSING_MIGRATION_KEY, '1');
      } else if (typeof appSettings.autoProcess !== 'boolean') {
        appSettings.autoProcess = true;
      }

      // Managed deployment details never belong in the user's custom endpoints.
      root.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings));
      return true;
    } catch (_) {
      return false;
    }
  }

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
      if (!hasSynapServiceFilter(options) || options.acceptAllDevices) return nativeRequestDevice(options);
      const patched = Object.assign({}, options, { filters: options.filters.slice() });
      addFilterOnce(patched.filters, 'synap');
      addFilterOnce(patched.filters, 'dk-');
      const optional = Array.isArray(options.optionalServices) ? options.optionalServices.slice() : [];
      if (!optional.some(function (service) { return String(service).toLowerCase() === SYNAP_SERVICE_UUID; })) {
        optional.push(SYNAP_SERVICE_UUID);
      }
      patched.optionalServices = optional;
      return nativeRequestDevice(patched);
    }

    try {
      Object.defineProperty(bluetooth, 'requestDevice', { configurable: true, writable: true, value: requestDevice });
      Object.defineProperty(bluetooth, '__synapDiscoveryCompatInstalled', { configurable: true, value: true });
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
    const heldKeys = new Set();

    function keyFor(name) { return PREFIX + String(name || 'lock'); }
    function readLease(key) {
      try {
        const value = JSON.parse(root.localStorage.getItem(key) || 'null');
        return value && typeof value === 'object' ? value : null;
      } catch (_) { return null; }
    }
    function writeLease(key) {
      try {
        root.localStorage.setItem(key, JSON.stringify({ owner: OWNER, expiresAt: Date.now() + LEASE_MS }));
        return true;
      } catch (_) {
        // Embedded/iOS BLE browsers are effectively single-page; do not make
        // missing localStorage fatal to capture.
        return true;
      }
    }
    function acquire(key) {
      if (heldKeys.has(key)) return false;
      const lease = readLease(key);
      if (lease && lease.owner !== OWNER && Number(lease.expiresAt || 0) > Date.now()) return false;
      if (!writeLease(key)) return false;
      const confirmed = readLease(key);
      if (confirmed && confirmed.owner !== OWNER) return false;
      heldKeys.add(key);
      return true;
    }
    function refresh(key) {
      const lease = readLease(key);
      if (lease && lease.owner !== OWNER && Number(lease.expiresAt || 0) > Date.now()) return false;
      return writeLease(key);
    }
    function release(key) {
      heldKeys.delete(key);
      try {
        const lease = readLease(key);
        if (!lease || lease.owner === OWNER) root.localStorage.removeItem(key);
      } catch (_) {}
    }

    async function request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      options = options || {};
      if (typeof callback !== 'function') throw new TypeError('Lock callback is required');
      const key = keyFor(name);
      let gotLock = acquire(key);
      if (!gotLock && !options.ifAvailable) {
        const deadline = Date.now() + LEASE_MS;
        while (!gotLock && Date.now() < deadline) {
          await new Promise(resolve => root.setTimeout(resolve, 250));
          gotLock = acquire(key);
        }
      }
      if (!gotLock) return callback(null);
      const lock = Object.freeze({ name: String(name), mode: 'exclusive' });
      const heartbeat = root.setInterval(function () { refresh(key); }, HEARTBEAT_MS);
      try { return await callback(lock); }
      finally { root.clearInterval(heartbeat); release(key); }
    }

    const fallback = Object.freeze({ request: request });
    try {
      Object.defineProperty(navigatorObject, 'locks', { configurable: true, enumerable: true, value: fallback });
    } catch (_) {
      try { navigatorObject.locks = fallback; } catch (_) {}
    }
  }

  function bindSettingsSafetyNet() {
    const settingsButton = root.document && root.document.getElementById('settingsButton');
    const closeButton = root.document && root.document.getElementById('closeSettingsButton');
    const dialog = root.document && root.document.getElementById('settingsDialog');
    if (!dialog) return;

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

  function installLazyLibraryPlayback() {
    const documentObject = root.document;
    if (!documentObject || typeof documentObject.addEventListener !== 'function' || documentObject.__synapLazyPlaybackInstalled) {
      return Boolean(documentObject && typeof documentObject.addEventListener === 'function');
    }
    documentObject.__synapLazyPlaybackInstalled = true;

    const objectUrls = new Set();
    const pending = new WeakMap();

    function recordingIdFromAudio(audio) {
      const card = audio && audio.closest ? audio.closest('.recording-card') : null;
      if (!card) return '';
      const id = String(card.id || '').replace(/^recording-/, '');
      return id && id !== card.id ? id : String(card.dataset && card.dataset.recordingId || '');
    }

    function statusNode(audio) {
      const content = audio && audio.closest ? audio.closest('.recording-content') : null;
      if (!content) return null;
      let status = content.querySelector('.recording-playback-status');
      if (!status) {
        status = documentObject.createElement('p');
        status.className = 'recording-playback-status';
        status.setAttribute('role', 'status');
        status.style.margin = '6px 0 0';
        status.style.fontSize = '0.72rem';
        status.style.color = 'var(--muted)';
        audio.insertAdjacentElement('afterend', status);
      }
      return status;
    }

    function setPlaybackStatus(audio, text, error) {
      const node = statusNode(audio);
      if (!node) return;
      node.textContent = text || '';
      node.hidden = !text;
      node.style.color = error ? 'var(--rose)' : 'var(--muted)';
    }

    function releaseAudioUrl(audio) {
      const url = audio && audio.dataset && audio.dataset.synapPlaybackUrl;
      if (!url || !objectUrls.has(url)) return;
      try { root.URL.revokeObjectURL(url); } catch (_) {}
      objectUrls.delete(url);
      delete audio.dataset.synapPlaybackUrl;
    }

    function loadAudio(audio) {
      if (!audio || audio.src || audio.currentSrc) return Promise.resolve(true);
      if (pending.has(audio)) return pending.get(audio);
      const recordingId = recordingIdFromAudio(audio);
      if (!recordingId || !root.DKAudioStore) return Promise.resolve(false);

      audio.setAttribute('aria-busy', 'true');
      setPlaybackStatus(audio, 'Loading audio…', false);

      const task = (async function () {
        try {
          const journal = new root.DKAudioStore({ onError: function () {} });
          const recording = await journal.get('recordings', recordingId);
          if (!recording) throw new Error('Recording is not available in this browser.');
          const blob = recording.blob || await journal.blob(recording);
          if (!blob || !blob.size) throw new Error('No playable audio is stored for this recording.');
          const url = root.URL.createObjectURL(blob);
          if (!audio.isConnected) {
            root.URL.revokeObjectURL(url);
            return false;
          }
          releaseAudioUrl(audio);
          objectUrls.add(url);
          audio.dataset.synapPlaybackUrl = url;
          audio.src = url;
          audio.preload = 'metadata';
          if (!audio.dataset.synapPlaybackErrorBound) {
            audio.dataset.synapPlaybackErrorBound = '1';
            audio.addEventListener('error', function () {
              setPlaybackStatus(audio, 'Audio could not be played. Reopen this recording and try again.', true);
            });
          }
          audio.load();
          setPlaybackStatus(audio, '', false);
          return true;
        } catch (error) {
          const message = String(error && error.message || '');
          const unavailable = message.includes('No complete audio frames') ||
            message.includes('not available in this browser') ||
            message.includes('No playable audio');
          setPlaybackStatus(audio,
            unavailable ? 'Source audio is not stored on this browser.' : 'Audio could not be loaded. Reopen this recording and try again.',
            true);
          return false;
        } finally {
          audio.removeAttribute('aria-busy');
          pending.delete(audio);
        }
      })();

      pending.set(audio, task);
      return task;
    }

    function warmOpenCard(card) {
      if (!card || !card.open) return;
      const audio = card.querySelector('audio');
      if (audio && !audio.src && !audio.currentSrc) loadAudio(audio);
    }

    // app.js creates recording-content in the card's own toggle handler. A
    // capture-phase document listener runs before that handler, so defer warming
    // until the toggle dispatch is complete and the native player exists.
    documentObject.addEventListener('toggle', function (event) {
      const card = event && event.target;
      if (!card || !card.classList || !card.classList.contains('recording-card') || !card.open) return;
      Promise.resolve().then(function () { warmOpenCard(card); });
    }, true);

    documentObject.addEventListener('pointerdown', function (event) {
      const audio = event && event.target && event.target.closest ? event.target.closest('audio') : null;
      if (!audio || !audio.closest('.recording-card') || audio.src || audio.currentSrc) return;
      loadAudio(audio);
    }, true);

    if (root.MutationObserver) {
      const list = documentObject.getElementById('recordingsList');
      if (list) {
        new root.MutationObserver(function (mutations) {
          mutations.forEach(function (mutation) {
            Array.prototype.forEach.call(mutation.addedNodes || [], function (node) {
              if (!node || node.nodeType !== 1) return;
              if (node.matches && node.matches('.recording-card')) warmOpenCard(node);
              const containingOpenCard = node.closest && node.closest('.recording-card[open]');
              if (containingOpenCard) warmOpenCard(containingOpenCard);
              if (node.querySelectorAll) node.querySelectorAll('.recording-card[open]').forEach(warmOpenCard);
            });
            Array.prototype.forEach.call(mutation.removedNodes || [], function (node) {
              if (!node || node.nodeType !== 1) return;
              const audios = [];
              if (node.matches && node.matches('audio')) audios.push(node);
              if (node.querySelectorAll) node.querySelectorAll('audio').forEach(function (audio) { audios.push(audio); });
              audios.forEach(releaseAudioUrl);
            });
          });
        }).observe(list, { childList: true, subtree: true });
        list.querySelectorAll('.recording-card[open]').forEach(warmOpenCard);
      }
    }

    if (typeof root.addEventListener === 'function') {
      root.addEventListener('pagehide', function () {
        objectUrls.forEach(function (url) { try { root.URL.revokeObjectURL(url); } catch (_) {} });
        objectUrls.clear();
      }, { once: true });
    }
    return true;
  }

  const synapCloudProcessingBootstrap = bootstrapSynapProcessingPreferences();
  const androidBleDiscoveryCompat = installAndroidBluetoothDiscoveryFallback();
  installWebLocksFallback();
  bindSettingsSafetyNet();
  const lazyLibraryPlayback = installLazyLibraryPlayback();

  root.SynapRuntimeCompat = Object.freeze({
    webLocksNative: Boolean(navigatorObject.locks && navigatorObject.locks.request && !String(navigatorObject.locks.request).includes('Lock callback is required')),
    androidBleDiscoveryCompat: androidBleDiscoveryCompat,
    synapCloudProcessingBootstrap: synapCloudProcessingBootstrap,
    lazyLibraryPlayback: lazyLibraryPlayback,
    installed: true
  });
})(globalThis);
