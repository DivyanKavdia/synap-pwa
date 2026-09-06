'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const authSource = fs.readFileSync('google-auth.js', 'utf8');
const routeSource = fs.readFileSync('backend/src/http/routes/auth.ts', 'utf8');
const pairingSource = fs.readFileSync('backend/src/http/auth-pairing.ts', 'utf8');
const pairPage = fs.readFileSync('auth-pair.html', 'utf8');

function loadAuth(navigator) {
  const storage = new Map();
  const sandbox = {
    navigator,
    URL,
    URLSearchParams,
    Promise,
    Date,
    JSON,
    Math,
    Error,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    location: { href: 'https://divyankavdia.github.io/synap-pwa/' },
    document: {
      querySelector() { return null; },
      addEventListener() {},
      removeEventListener() {},
      createElement() { return {}; },
      head: { appendChild() {} },
    },
    fetch() { throw new Error('network should not be used by capability tests'); },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(authSource, sandbox, { filename: 'google-auth.js' });
  return sandbox.SynapAuth;
}

// Android and desktop retain the existing Google Identity Services transport.
assert.strictEqual(loadAuth({
  userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/152 Mobile Safari/537.36',
  platform: 'Linux armv8l',
  maxTouchPoints: 5,
  bluetooth: {},
}).needsExternalIosPairing(), false, 'Android must keep direct GIS login');

assert.strictEqual(loadAuth({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152 Safari/537.36',
  platform: 'Win32',
  maxTouchPoints: 0,
  bluetooth: {},
}).needsExternalIosPairing(), false, 'desktop Chromium must keep direct GIS login');

// iOS Web-Bluetooth contexts use Safari pairing instead of unsupported embedded GIS.
assert.strictEqual(loadAuth({
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit Bluefy',
  platform: 'iPhone',
  maxTouchPoints: 5,
  bluetooth: {},
}).needsExternalIosPairing(), true, 'Bluefy on iPhone must use Safari pairing');

assert.strictEqual(loadAuth({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
  platform: 'MacIntel',
  maxTouchPoints: 5,
  bluetooth: {},
}).needsExternalIosPairing(), true, 'iPad desktop UA with Web Bluetooth must use Safari pairing');

// Regression guards: do not remove the working auth/session APIs while adding pairing.
assert.match(authSource, /\/v1\/auth\/google/, 'existing Google exchange must remain');
assert.match(authSource, /google\.accounts\.id\.prompt/, 'existing One Tap flow must remain');
assert.match(authSource, /google\.accounts\.id\.renderButton/, 'existing explicit Google button must remain');
assert.match(authSource, /needsExternalIosPairing\(\) \? signInViaPairing\(\) : signInWithGis\(\)/,
  'signIn must route by capability and keep GIS as the default');
assert.match(authSource, /x-safari-https:\/\//, 'iOS pairing should request Safari explicitly');
assert.match(authSource, /\/v1\/auth\/pair\/start/, 'pairing start endpoint must be used');
assert.match(authSource, /\/v1\/auth\/pair\/claim/, 'pairing claim endpoint must be used');

assert.match(routeSource, /router\.post\(\s*['"]\/auth\/google['"]/, 'backend Google route must remain');
assert.match(routeSource, /['"]\/auth\/pair\/start['"]/, 'backend must expose pairing start');
assert.match(routeSource, /['"]\/auth\/pair\/approve['"]/, 'backend must expose pairing approval');
assert.match(routeSource, /['"]\/auth\/pair\/claim['"]/, 'backend must expose pairing claim');

assert.match(pairingSource, /PAIRING_TTL_MS = 5 \* 60 \* 1000/, 'pairing must expire after five minutes');
assert.match(pairingSource, /createHash\('sha256'\)/, 'claim secret must be stored hashed');
assert.doesNotMatch(pairingSource, /idToken|id_token|access_token|refresh_token/,
  'pairing store must not persist identity or session tokens');
assert.match(pairingSource, /state: 'consumed'/, 'pairing claim must be one-time');

assert.match(pairPage, /https:\/\/accounts\.google\.com\/gsi\/client/, 'Safari page must use Google GIS');
assert.match(pairPage, /\/v1\/auth\/pair\/approve/, 'Safari page must approve the pairing via backend');
assert.doesNotMatch(pairPage, /pair_secret/, 'Safari must never receive the Bluefy claim secret');

console.log('auth-pairing tests passed');
