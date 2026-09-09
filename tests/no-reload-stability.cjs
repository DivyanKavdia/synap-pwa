'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const historySource = fs.readFileSync(path.join(root, 'cloud-history.js'), 'utf8');
const captureSource = fs.readFileSync(path.join(root, 'capture-stability.js'), 'utf8');

function loadHistory() {
  const context = {
    console, Date, JSON, Error, Map, Set, Promise, Object, Array, String, Number,
    Boolean, Math, Intl, setTimeout, clearTimeout,
    document: { readyState: 'loading', addEventListener() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(historySource, context, { filename: 'cloud-history.js' });
  return context.SynapCloudHistory;
}

const history = loadHistory();
assert(history, 'cloud history API should load');
assert.equal(typeof history.meaningfullyChanged, 'function');

const base = {
  id: 'r1', transcript: 'same', summary: 'same', processingState: 'done',
  restoredAt: '2026-09-09T00:00:00Z', processedAt: '2026-09-09T00:00:00Z'
};
const timestampOnly = Object.assign({}, base, {
  restoredAt: '2026-09-09T00:05:00Z', processedAt: '2026-09-09T00:05:00Z',
  processingUpdatedAt: '2026-09-09T00:05:00Z'
});
assert.equal(history.meaningfullyChanged(base, timestampOnly), false,
  'bookkeeping timestamps must not create a fake cloud-history change');
assert.equal(history.meaningfullyChanged(base, Object.assign({}, timestampOnly, { transcript: 'new text' })), true,
  'real transcript changes must still update local memory');

const historyCode = historySource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(historyCode, /location\s*\.\s*reload\s*\(/,
  'cloud sync must never reload the document because reload disconnects Web Bluetooth');

assert.doesNotMatch(captureSource, /\bconnect\s*\.\s*click\s*\(/,
  'capture continuity must not run a second synthetic reconnect loop');
assert.match(captureSource, /start\s*\.\s*click\s*\(/,
  'capture continuity may resume recording only after app.js has re-established idle GATT state');

console.log('PASS: cloud sync is in-place and reconnect has one owner.');
