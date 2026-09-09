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
 * Synap cloud is a managed provider. Runtime preferences may select it and may
 * default automatic processing on, but deployment details such as the Cloud Run
 * URL and Google client ID must never be copied into the user's legacy endpoint
 * settings. synap-backend.js owns the managed transport internally.
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

      // One-time product migration: Synap Cloud should normally process a saved
      // recording automatically. After migration an explicit opt-out is kept.
      if (root.localStorage.getItem(CLOUD_PROCESSING_MIGRATION_KEY) !== '1') {
        appSettings.autoProcess = true;
        root.localStorage.setItem(CLOUD_PROCESSING_MIGRATION_KEY, '1');
      } else if (typeof appSettings.autoProcess !== 'boolean') {
        appSettings.autoProcess = true;
      }

      // Deliberately do not set endpoint or llmEndpoint here. Those fields are
      // for the Custom provider only; Synap Cloud transport is managed internally.
      root.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings));
      return true;
    } catch (_) {
      // Storage can be blocked in private/embedded modes. Capture must still boot.
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

  function installLazyLibraryPlayback() {
    const documentObject = root.document;
    if (!documentObject || documentObject.__synapLazyPlaybackInstalled) return Boolean(documentObject);
    documentObject.__synapLazyPlaybackInstalled = true;

    const objectUrls = new Set();
    const pending = new WeakMap();

    function recordingIdFromAudio(audio) {
      const card = audio && audio.closest ? audio.closest('.recording-card') : null;
      if (!card) return '';
      const id = String(card.id || '').replace(/^recording-/, '');
      if (id && id !== card.id) return id;
      return String(card.dataset && card.dataset.recordingId || '');
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
          objectUrls.add(url);
          audio.dataset.synapPlaybackUrl = url;
          audio.src = url;
          audio.preload = 'metadata';
          audio.load();
          setPlaybackStatus(audio, '', false);
          return true;
        } catch (error) {
          const cloudOnly = String(error && error.message || '').includes('No complete audio frames') ||
            String(error && error.message || '').includes('not available in this browser');
          setPlaybackStatus(audio,
            cloudOnly ? 'Source audio is not stored on this browser.' : 'Audio could not be loaded. Try reopening this recording.',
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

    documentObject.addEventListener('toggle', function (event) {
      const card = event && event.target;
      if (card && card.classList && card.classList.contains('recording-card') && card.open) {
        warmOpenCard(card);
      }
    }, true);

    // If the user reaches Play before the open-card warmup finishes, ensure the
    // source starts loading immediately rather than leaving a dead native player.
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
              if (node.querySelectorAll) node.querySelectorAll('.recording-card[open]').forEach(warmOpenCard);
            });
            Array.prototype.forEach.call(mutation.removedNodes || [], function (node) {
              if (!node || node.nodeType !== 1 || !node.querySelectorAll) return;
              const audios = [];
              if (node.matches && node.matches('audio')) audios.push(node);
              node.querySelectorAll('audio').forEach(function (audio) { audios.push(audio); });
              audios.forEach(function (audio) {
                const url = audio.dataset && audio.dataset.synapPlaybackUrl;
                if (url && objectUrls.has(url)) {
                  root.URL.revokeObjectURL(url);
                  objectUrls.delete(url);
                }
              });
            });
          });
        }).observe(list, { childList: true, subtree: true });
        list.querySelectorAll('.recording-card[open]').forEach(warmOpenCard);
      }
    }

    root.addEventListener('pagehide', function () {
      objectUrls.forEach(function (url) { try { root.URL.revokeObjectURL(url); } catch (_) {} });
      objectUrls.clear();
    }, { once: true });
    return true;
  }

  const synapCloudProcessingBootstrap = bootstrapSynapProcessingPreferences();
  const androidBleDiscoveryCompat = installAndroidBluetoothDiscoveryFallback();
  installWebLocksFallback();
  bindSettingsSafetyNet();
  installLazyLibraryPlayback();

  root.SynapRuntimeCompat = Object.freeze({
    webLocksNative: Boolean(navigatorObject.locks && navigatorObject.locks.request && !String(navigatorObject.locks.request).includes('Lock callback is required')),
    androidBleDiscoveryCompat: androidBleDiscoveryCompat,
    synapCloudProcessingBootstrap: synapCloudProcessingBootstrap,
    lazyLibraryPlayback: true,
    installed: true
  });
})(globalThis);
