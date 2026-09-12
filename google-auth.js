/* Synap Google Sign-In.
 *
 * Flow on normal browsers (Android Chrome/PWA, desktop Chromium):
 *   Google Identity Services  ->  Google ID token
 *   POST /v1/auth/google      ->  Synap access token (1h) + refresh token (30d)
 *
 * Flow on iOS Web-Bluetooth browsers (for example Bluefy):
 *   Bluefy starts a short-lived pairing transaction
 *   Safari completes Google Sign-In and approves that transaction
 *   Bluefy claims the transaction -> the same Synap access + refresh tokens
 *
 * The iOS path is additive. Browsers where Google Identity Services already
 * works keep the original path unchanged.
 */
(function (root) {
  'use strict';

  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var STORAGE_KEY = 'synap-auth-session-v1';
  var CONFIG_KEY = 'synap-backend-config-v1';

  /* Deployment defaults, overridable in Settings at runtime.
     The client ID is not a secret — it is public by design and ships in every
     Google Sign-In page. */
  var DEFAULTS = {
    clientId: '435475937223-7d2lmg7oc0887tc8psbt8ikgn0jkm62q.apps.googleusercontent.com',
    backendUrl: 'https://synap-backend-435475937223.asia-south1.run.app'
  };

  var listeners = [];
  var gisPromise = null;
  var refreshPromise = null;
  var pairingPromise = null;

  function config() {
    try {
      var stored = JSON.parse(root.localStorage.getItem(CONFIG_KEY) || '{}');
      return {
        clientId: String(stored.clientId || DEFAULTS.clientId || '').trim(),
        backendUrl: String(stored.backendUrl || DEFAULTS.backendUrl || '').replace(/\/+$/, '')
      };
    } catch (error) {
      return { clientId: DEFAULTS.clientId, backendUrl: DEFAULTS.backendUrl };
    }
  }

  function saveConfig(next) {
    var merged = {
      clientId: String(next.clientId || '').trim(),
      backendUrl: String(next.backendUrl || '').replace(/\/+$/, '')
    };
    if (merged.backendUrl && new URL(merged.backendUrl).protocol !== 'https:') {
      throw new Error('The Synap backend URL must use HTTPS.');
    }
    root.localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
    return merged;
  }

  function readSession() {
    try {
      return JSON.parse(root.localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (error) {
      return null;
    }
  }

  function writeSession(session) {
    if (session) root.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else root.localStorage.removeItem(STORAGE_KEY);
    listeners.forEach(function (listener) {
      try { listener(session); } catch (error) { /* a bad listener must not break auth */ }
    });
  }

  function onChange(listener) {
    listeners.push(listener);
    try { listener(readSession()); } catch (error) { /* ignore */ }
    return function () {
      listeners = listeners.filter(function (entry) { return entry !== listener; });
    };
  }

  /* Load the Google Identity Services script once, on demand. */
  function loadGis() {
    if (root.google && root.google.accounts && root.google.accounts.id) return Promise.resolve();
    if (gisPromise) return gisPromise;

    gisPromise = new Promise(function (resolve, reject) {
      var existing = root.document.querySelector('script[data-synap-gis]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error('Google Sign-In failed to load.')); });
        return;
      }
      var script = root.document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.setAttribute('data-synap-gis', '1');
      script.onload = function () { resolve(); };
      script.onerror = function () {
        gisPromise = null;
        reject(new Error('Google Sign-In could not be reached. Check your connection.'));
      };
      root.document.head.appendChild(script);
    });
    return gisPromise;
  }

  function api(path, options) {
    var settings = config();
    if (!settings.backendUrl) {
      return Promise.reject(new Error('Add your Synap backend URL in Settings.'));
    }
    var init = options || {};
    return root.fetch(settings.backendUrl + path, {
      method: init.method || 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'X-Synap-Client': 'pwa', 'X-Synap-Schema': '1' },
        init.headers || {}
      ),
      body: init.body,
      signal: init.signal
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
        if (!response.ok) {
          var message = (data && data.error && data.error.message) || ('HTTP ' + response.status);
          var failure = new Error(message);
          failure.status = response.status;
          failure.code = data && data.error && data.error.code;
          failure.retryable = Boolean(data && data.error && data.error.retryable);
          throw failure;
        }
        return data;
      });
    });
  }

  function storeTokens(tokens, profile) {
    var session = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      /* Renew a minute early so a request never races its own expiry. */
      expiresAt: Date.now() + Math.max(0, (tokens.expires_in || 3600) - 60) * 1000,
      profile: profile || (readSession() || {}).profile || null
    };
    writeSession(session);
    return session;
  }

  function finishSession(result) {
    var session = storeTokens(result, null);
    return me().then(function (profile) {
      session.profile = profile;
      writeSession(session);
      return session;
    }).catch(function () { return session; });
  }

  /**
   * Google explicitly does not support Sign in with Google inside iOS WebViews.
   * Safari itself is fine, but Safari still lacks Web Bluetooth. A browser such
   * as Bluefy therefore needs the two-browser pairing flow. Capability detection
   * is primary; the Bluefy UA check is only a compatibility fallback.
   */
  function needsExternalIosPairing() {
    var nav = root.navigator || {};
    var ua = String(nav.userAgent || '');
    var platform = String(nav.platform || '');
    var touchPoints = Number(nav.maxTouchPoints || 0);
    var ios = /iPad|iPhone|iPod/i.test(ua) || (platform === 'MacIntel' && touchPoints > 1);
    var webBluetooth = Boolean(nav.bluetooth);
    return /Bluefy/i.test(ua) || (ios && webBluetooth);
  }

  function pairingPageUrl(pairing, settings) {
    var base = root.location && root.location.href ? root.location.href : './';
    var url = new URL('auth-pair.html', base);
    url.searchParams.set('pair_id', pairing.pair_id);
    url.searchParams.set('backend', settings.backendUrl);
    url.searchParams.set('client_id', settings.clientId);
    return url.toString();
  }

  function safariUrl(httpsUrl) {
    return String(httpsUrl).replace(/^https:\/\//i, 'x-safari-https://');
  }

  function launchSafari(url) {
    var target = safariUrl(url);
    /* x-safari-https asks iOS to leave the Web-Bluetooth browser and open the
       transaction in Safari. The normal HTTPS URL contains no claim secret and
       is safe to copy manually if a particular iOS build rejects the scheme. */
    try {
      if (root.location) root.location.href = target;
      else throw new Error('location_unavailable');
    } catch (error) {
      throw new Error('Could not open Safari. Open the Synap sign-in link in Safari and try again.');
    }
  }

  function waitForPairing(pairing) {
    var expiresAt = Date.now() + Math.max(30, Number(pairing.expires_in || 300)) * 1000;
    var stopped = false;
    var timer = null;
    var visibilityHandler = null;
    /* Claiming is a one-time consume, so two in-flight claims race: the first
       succeeds and the second is told the pairing was already used. That is
       not hypothetical on iOS — returning from Safari fires visibilitychange,
       which schedules a poll at the exact moment one is usually outstanding. */
    var inFlight = false;

    function cleanup() {
      stopped = true;
      if (timer) root.clearTimeout(timer);
      timer = null;
      if (visibilityHandler && root.document) {
        root.document.removeEventListener('visibilitychange', visibilityHandler);
      }
    }

    return new Promise(function (resolve, reject) {
      function schedule(delay) {
        if (stopped) return;
        if (Date.now() >= expiresAt) {
          cleanup();
          reject(new Error('Google Sign-In expired. Tap Sign in and try again.'));
          return;
        }
        if (timer) root.clearTimeout(timer);
        timer = root.setTimeout(attempt, delay);
      }

      function attempt() {
        if (stopped) return;
        timer = null;
        if (inFlight) {
          /* Come back rather than run a second claim beside the first. */
          schedule(400);
          return;
        }
        inFlight = true;
        api('/v1/auth/pair/claim', {
          body: JSON.stringify({
            pair_id: pairing.pair_id,
            pair_secret: pairing.pair_secret
          })
        }).then(function (result) {
          inFlight = false;
          if (!result || result.status === 'pending') {
            schedule(1400);
            return;
          }
          if (result.status !== 'approved' || !result.access_token || !result.refresh_token) {
            throw new Error('Google Sign-In could not be completed.');
          }
          cleanup();
          return finishSession(result).then(resolve, reject);
        }).catch(function (error) {
          inFlight = false;
          /* 409 means this pairing was already consumed. If a session exists,
             we are the ones who consumed it — a duplicate poll landing after
             the successful one. Reporting that as a failure tells a user who
             is signed in that signing in failed. */
          if (error && error.status === 409 && isSignedIn()) {
            cleanup();
            resolve(readSession());
            return;
          }
          if (error && (error.status === 404 || error.status === 409 || error.status === 410 || error.status === 401)) {
            cleanup();
            reject(error);
            return;
          }
          /* A brief network loss while switching apps should not destroy the
             login transaction. Retry until the server-side expiry. */
          schedule(1800);
        });
      }

      if (root.document) {
        visibilityHandler = function () {
          if (root.document.visibilityState === 'visible') schedule(50);
        };
        root.document.addEventListener('visibilitychange', visibilityHandler);
      }
      schedule(900);
    });
  }

  function signInViaPairing() {
    if (pairingPromise) return pairingPromise;
    var settings = config();
    if (!settings.clientId) return Promise.reject(new Error('Add your Google client ID in Settings.'));
    if (!settings.backendUrl) return Promise.reject(new Error('Add your Synap backend URL in Settings.'));

    pairingPromise = api('/v1/auth/pair/start', { body: '{}' }).then(function (pairing) {
      if (!pairing || !pairing.pair_id || !pairing.pair_secret) {
        throw new Error('Synap could not start Google Sign-In.');
      }
      var loginUrl = pairingPageUrl(pairing, settings);
      /* Start polling before leaving Bluefy so it is ready as soon as the app
         becomes visible again after Safari approval. */
      var result = waitForPairing(pairing);
      launchSafari(loginUrl);
      return result;
    }).then(function (session) {
      pairingPromise = null;
      return session;
    }).catch(function (error) {
      pairingPromise = null;
      throw error;
    });
    return pairingPromise;
  }

  /* Original Google Identity Services path. Kept intact for Android/desktop. */
  function signInWithGis() {
    var settings = config();
    if (!settings.clientId) {
      return Promise.reject(new Error('Add your Google client ID in Settings.'));
    }

    return loadGis().then(function () {
      return new Promise(function (resolve, reject) {
        var settled = false;
        root.google.accounts.id.initialize({
          client_id: settings.clientId,
          auto_select: false,
          cancel_on_tap_outside: true,
          callback: function (response) {
            if (settled) return;
            settled = true;
            if (!response || !response.credential) {
              reject(new Error('Google Sign-In returned no credential.'));
              return;
            }
            resolve(response.credential);
          }
        });

        root.google.accounts.id.prompt(function (notification) {
          /* One Tap can be suppressed by browser settings or a prior dismissal.
             Fall back to the explicit button rather than leaving the user
             staring at nothing. */
          if (settled) return;
          var blocked = notification &&
            ((notification.isNotDisplayed && notification.isNotDisplayed()) ||
             (notification.isSkippedMoment && notification.isSkippedMoment()));
          if (blocked) {
            settled = true;
            reject(new Error('one_tap_unavailable'));
          }
        });
      });
    }).then(function (credential) {
      return api('/v1/auth/google', { body: JSON.stringify({ id_token: credential }) });
    }).then(finishSession);
  }

  /** Choose transport automatically without changing the resulting Synap session. */
  function signIn() {
    return needsExternalIosPairing() ? signInViaPairing() : signInWithGis();
  }

  /**
   * Render an explicit "Sign in with Google" button into a container. Used when
   * One Tap is unavailable on browsers where GIS itself is supported.
   */
  function renderButton(container, onSuccess, onError) {
    var settings = config();
    if (!settings.clientId) {
      if (onError) onError(new Error('Add your Google client ID in Settings.'));
      return;
    }
    loadGis().then(function () {
      root.google.accounts.id.initialize({
        client_id: settings.clientId,
        callback: function (response) {
          if (!response || !response.credential) {
            if (onError) onError(new Error('Google Sign-In returned no credential.'));
            return;
          }
          api('/v1/auth/google', { body: JSON.stringify({ id_token: response.credential }) })
            .then(finishSession)
            .then(function (session) { if (onSuccess) onSuccess(session); })
            .catch(function (error) { if (onError) onError(error); });
        }
      });
      root.google.accounts.id.renderButton(container, {
        theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 260
      });
    }).catch(function (error) { if (onError) onError(error); });
  }

  function refresh() {
    var session = readSession();
    if (!session || !session.refreshToken) {
      return Promise.reject(new Error('Sign in to sync your memories.'));
    }
    /* Collapse concurrent refreshes: the processor runs several jobs at once
       and a burst of refreshes would rotate tokens under each other. */
    if (refreshPromise) return refreshPromise;

    refreshPromise = api('/v1/auth/refresh', {
      body: JSON.stringify({ refresh_token: session.refreshToken })
    }).then(function (tokens) {
      refreshPromise = null;
      return storeTokens(tokens, session.profile);
    }).catch(function (error) {
      refreshPromise = null;
      /* A revoked or expired refresh token is terminal: clear it so the UI
         asks for sign-in instead of retrying forever. */
      if (error.status === 401) writeSession(null);
      throw error;
    });
    return refreshPromise;
  }

  /* Return a currently valid access token, refreshing when needed. */
  function accessToken() {
    var session = readSession();
    if (!session) return Promise.reject(new Error('Sign in to sync your memories.'));
    if (session.accessToken && session.expiresAt > Date.now()) {
      return Promise.resolve(session.accessToken);
    }
    return refresh().then(function (next) { return next.accessToken; });
  }

  /* Authenticated fetch against the backend, retrying once after a refresh. */
  function authedFetch(path, options) {
    var init = options || {};
    return accessToken().then(function (token) {
      var settings = config();
      return root.fetch(settings.backendUrl + path, {
        method: init.method || 'GET',
        headers: Object.assign({
          Authorization: 'Bearer ' + token,
          'X-Synap-Client': 'pwa',
          'X-Synap-Schema': '1'
        }, init.headers || {}),
        body: init.body,
        signal: init.signal
      });
    }).then(function (response) {
      if (response.status !== 401 || init.__retried) {
        root.SynapProcessingRecovery?.observeResponse(path, response, authedFetch);
        return response;
      }
      return refresh().then(function () {
        return authedFetch(path, Object.assign({}, init, { __retried: true }));
      });
    });
  }

  function me() {
    return authedFetch('/v1/auth/me').then(function (response) {
      if (!response.ok) throw new Error('Could not load your profile.');
      return response.json();
    });
  }

  function signOut() {
    var session = readSession();
    var done = session
      ? authedFetch('/v1/auth/signout', { method: 'POST' }).catch(function () { /* local sign-out still proceeds */ })
      : Promise.resolve();
    return done.then(function () {
      writeSession(null);
      if (root.google && root.google.accounts && root.google.accounts.id) {
        try { root.google.accounts.id.disableAutoSelect(); } catch (error) { /* ignore */ }
      }
    });
  }

  function isSignedIn() {
    var session = readSession();
    return Boolean(session && session.refreshToken);
  }

  root.SynapAuth = {
    config: config,
    saveConfig: saveConfig,
    signIn: signIn,
    signOut: signOut,
    renderButton: renderButton,
    refresh: refresh,
    accessToken: accessToken,
    authedFetch: authedFetch,
    me: me,
    session: readSession,
    isSignedIn: isSignedIn,
    onChange: onChange,
    needsExternalIosPairing: needsExternalIosPairing,
    STORAGE_KEY: STORAGE_KEY,
    CONFIG_KEY: CONFIG_KEY
  };
})(globalThis);
