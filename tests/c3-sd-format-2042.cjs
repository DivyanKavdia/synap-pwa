'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const ui = fs.readFileSync('devices/chakshu/capture-preview.js','utf8');
const transfer = fs.readFileSync('devices/chakshu/transfer.js','utf8');

test('C3 format is deliberately advertised through firmware feature bit 2', () => {
  assert.match(ui, /info\?\.id === 2 && \(info\.mediaFeatures & 4\)/);
  assert.match(ui, /Format SD Card/);
  assert.match(ui, /ALL files on the card will be permanently erased/);
});

test('format is a single destructive op19 followed by read-only catalogue', () => {
  const start = ui.indexOf('  async function formatSD()');
  const end = ui.indexOf('  async function startOffline(', start);
  assert.ok(start > 0 && end > start);
  const format = ui.slice(start, end);
  assert.match(format, /await client\(\)\.request\(19\)/);
  assert.match(format, /const files = await api\(\)\.catalogue\(\)/);
  assert.doesNotMatch(format, /api\(\)\.refreshSD\(\)/);
  assert.match(format, /if \(!Array\.isArray\(files\) \|\| files\.length\)/);
  assert.ok(format.indexOf('localStorage.removeItem(key)') > format.indexOf('const files = await api().catalogue()'));
});

test('BLE permits bounded slow format completion, never blindly reissues op19', () => {
  assert.match(transfer, /op === 19 \? 120000 : RESPONSE_DEADLINE_MS/);
  assert.match(transfer, /const deadline = Date\.now\(\)/);
});
