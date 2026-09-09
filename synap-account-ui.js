/* Settings wiring for the Synap account and memory provider.
 *
 * Kept separate from google-auth.js so the auth module stays testable without a
 * DOM, and separate from app.js so a settings change never risks the capture
 * path. Everything here degrades quietly: if the markup is missing, this file
 * does nothing rather than throwing during startup and taking the recorder
 * down with it.
 */
(function (root) {
  'use strict';

  var PREF_KEY = 'synap-ai-provider-settings';

  function el(id) {
    return root.document ? root.document.getElementById(id) : null;
  }

  function prefs() {
    try {
      return JSON.parse(root.localStorage.getItem(PREF_KEY) || '{}') || {};
    } catch (error) {
      return {};
    }
  }

  function savePrefs(next) {
    var merged = Object.assign(prefs(), next);
    root.localStorage.setItem(PREF_KEY, JSON.stringify(merged));
    return merged;
  }

  /* Keep recovery isolated from account/settings code. This file is already
     loaded after google-auth.js and synap-backend.js in every production shell,
     so it is a stable place to attach the small optional guard without changing
     capture/app startup ordering. Cloud processing is online-only, therefore the
     dynamically loaded module does not need to be part of the offline shell. */
  function loadProcessingRecovery() {
    if (!root.document || !root.document.createElement || root.SynapProcessingRecovery) return;
    if (root.document.querySelector && root.document.querySelector('script[data-synap-processing-recovery]')) return;
    var parent = root.document.head || root.document.documentElement;
    if (!parent || typeof parent.appendChild !== 'function') return;
    var script = root.document.createElement('script');
    script.src = 'processing-recovery.js?v=1.0.0-recovery1';
    script.async = true;
    script.setAttribute('data-synap-processing-recovery', '1');
    parent.appendChild(script);
  }

  function bind() {
    var provider = el('providerInput');
    var accountFields = el('synapAccountFields');
    var customFields = el('customEndpointFields');
    var form = el('settingsForm');
    if (!provider || !accountFields || !customFields || !form) return;

    var signIn = el('synapSignInButton');
    var signOut = el('synapSignOutButton');
    var buttonHost = el('synapSignInButtonHost');
    var nameEl = el('synapAccountName');
    var emailEl = el('synapAccountEmail');
    var statusEl = el('synapAccountStatus');
    var backendInput = el('synapBackendUrlInput');
    var clientInput = el('synapClientIdInput');
    var connection = el('synapConnectionDetails');

    var auth = root.SynapAuth;
    if (!auth) return;

    function status(message, kind) {
      if (!statusEl) return;
      statusEl.textContent = message || '';
      statusEl.dataset.kind = kind || '';
    }

    function maybeProcessPending(session) {
      var auto = el('autoProcessInput');
      if (provider.value !== 'synap' || !session || !session.refreshToken || !auto || !auto.checked) return;
      /* The processing button is the public seam into app.js's private FIFO
         processor. Trigger it only after authentication succeeds; signed-out
         recordings stay local and pending. */
      root.setTimeout(function () {
        var run = el('runQueueButton');
        if (run) run.click();
      }, 0);
    }

    function applyProvider() {
      var usingSynap = provider.value === 'synap';
      accountFields.hidden = !usingSynap;
      customFields.hidden = usingSynap;
    }

    function renderSession(session) {
      var signedIn = Boolean(session && session.refreshToken);
      if (signIn) signIn.hidden = signedIn;
      if (signOut) signOut.hidden = !signedIn;
      if (buttonHost && signedIn) buttonHost.hidden = true;

      var profile = session && session.profile;
      if (nameEl) nameEl.textContent = signedIn ? (profile && profile.name) || 'Signed in' : 'Not signed in';
      if (emailEl) {
        emailEl.textContent = signedIn
          ? (profile && profile.email) || 'Your memories sync and stay encrypted.'
          : 'Sign in with Google to build your second brain.';
      }
    }

    /* Deployment configuration lives in SynapAuth, not the user's processing
       endpoint settings. Production defaults keep this advanced panel hidden;
       it remains available only for a fork/self-hosted build or config failure. */
    var settings = auth.config();
    if (backendInput) backendInput.value = settings.backendUrl || '';
    if (clientInput) clientInput.value = settings.clientId || '';

    function revealConnection(force) {
      if (!connection) return;
      var configured = Boolean(settings.backendUrl && settings.clientId);
      connection.hidden = configured && !force;
      if (force) connection.open = true;
    }
    revealConnection(false);

    /*
     * The production UI no longer exposes OpenAI as a processing authority.
     * Older PWA builds could leave provider=openai in localStorage, and that
     * hidden preference was enough for ai-providers.js to call OpenAI directly
     * with a user key even after Synap Cloud had been introduced. Migrate that
     * stale value explicitly so one recording has exactly one paid AI pipeline.
     */
    var stored = prefs().provider;
    if (stored === 'openai' || (stored !== 'synap' && stored !== 'openai' && stored !== 'custom')) {
      stored = 'synap';
      savePrefs({ provider: stored });
    }
    provider.value = stored === 'synap' ? 'synap' : 'custom';
    applyProvider();

    provider.addEventListener('change', function () {
      savePrefs({ provider: provider.value });
      applyProvider();
      maybeProcessPending(auth.session());
    });

    auth.onChange(renderSession);

    if (signIn) {
      signIn.addEventListener('click', function () {
        /* Production builds already ship this config. Persist only what the
           advanced self-host panel currently contains; normal users never need
           to paste Cloud Run or OAuth values to sign in. */
        try {
          settings = auth.saveConfig({
            backendUrl: backendInput ? backendInput.value : settings.backendUrl,
            clientId: clientInput ? clientInput.value : settings.clientId
          });
        } catch (error) {
          status(error.message, 'error');
          revealConnection(true);
          return;
        }

        status('Opening Google Sign-In…');
        signIn.disabled = true;

        auth.signIn().then(function () {
          status('Signed in. Your memories will sync from now on.', 'ok');
          maybeProcessPending(auth.session());
        }).catch(function (error) {
          /* One Tap is routinely suppressed in installed PWAs and on iOS.
             Fall back to the explicit button rather than dead-ending. */
          if (error && error.message === 'one_tap_unavailable' && buttonHost) {
            buttonHost.hidden = false;
            buttonHost.innerHTML = '';
            status('Use the Google button below to continue.');
            auth.renderButton(buttonHost, function () {
              buttonHost.hidden = true;
              status('Signed in. Your memories will sync from now on.', 'ok');
              maybeProcessPending(auth.session());
            }, function (failure) {
              status(failure.message || 'Sign-in failed.', 'error');
            });
            return;
          }
          status((error && error.message) || 'Sign-in failed.', 'error');
          // Sign-in failure is the only time these values are worth showing.
          revealConnection(true);
        }).then(function () {
          signIn.disabled = false;
        }, function () {
          signIn.disabled = false;
        });
      });
    }

    if (signOut) {
      signOut.addEventListener('click', function () {
        signOut.disabled = true;
        auth.signOut().then(function () {
          status('Signed out on every device.', 'ok');
        }).catch(function () {
          status('Signed out on this device.', 'ok');
        }).then(function () {
          signOut.disabled = false;
        });
      });
    }

    form.addEventListener('submit', function () {
      savePrefs({ provider: provider.value });
      if (provider.value !== 'synap') return;
      try {
        settings = auth.saveConfig({
          backendUrl: backendInput ? backendInput.value : settings.backendUrl,
          clientId: clientInput ? clientInput.value : settings.clientId
        });
        revealConnection(false);
        maybeProcessPending(auth.session());
      } catch (error) {
        status(error.message, 'error');
      }
    }, true);

    renderSession(auth.session());
  }

  loadProcessingRecovery();
  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }

  root.SynapAccountUI = { bind: bind, loadProcessingRecovery: loadProcessingRecovery };
})(globalThis);
