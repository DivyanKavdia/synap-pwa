'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const caps = require('../devices/capabilities.js');
const { decode } = require('../devices/modules.js');
function info(id, version, state, supported = 0, ready = 0, media = 0) {
  const v = new DataView(new ArrayBuffer(20));
  [0xc7, 1, id, 1].forEach((n, i) => v.setUint8(i, n));
  v.setUint16(4, supported, true); v.setUint16(6, ready, true);
  v.setUint8(14, media); v.setUint8(17, version); v.setUint8(18, state);
  return decode(v);
}
function render(module) {
  const nodes = {};
  const element = () => ({ dataset: {}, children: [], replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); }, addEventListener() {} });
  const document = { readyState: 'complete', getElementById(id) { return nodes[id] ||= element(); },
    createElement: element, querySelectorAll: () => [] };
  vm.runInNewContext(fs.readFileSync('devices/panel.js', 'utf8'), {
    document, SynapCapabilities: caps, SynapModules: { client: { module }, ERRORS: [] },
    addEventListener() {},
  });
  return nodes;
}
test('Odyssey reports boot SD state and C3 media-v1 unlocks only SD transfer', () => {
  for (const id of [1, 2]) for (const state of [0, 1, 2, 3]) {
    const module = info(id, 1, state), nodes = render(module);
    assert.equal(module.sdDetectionState, state);
    assert.equal(caps.hasMedia(module), false, 'legacy detection-only descriptors stay media-locked');
    assert.equal(nodes.chakshuChecks.hidden, true);
    assert.match(nodes.moduleFeatures.children[0].textContent,
      [/not checked/, /detected at startup/, /check failed at startup/, /not detected at startup/][state]);
    if (state === 1) assert.match(nodes.moduleStatus.textContent, /detected at startup/);
    if (state === 2) assert.match(nodes.moduleStatus.textContent, /wiring and filesystem/);
    if (state === 3) assert.match(nodes.moduleStatus.textContent, /restart the pendant/);
  }

  const sd = caps.flag('sd');
  const c3 = info(2, 1, 1, sd, sd, 1), nodes = render(c3);
  assert.equal(caps.supports(c3, 'sd'), true);
  assert.equal(caps.ready(c3, 'sd'), true);
  assert.equal(caps.hasMedia(c3), true);
  assert.equal(caps.canCapture(c3, 'photo'), false);
  assert.equal(nodes.chakshuChecks.hidden, true, 'C3 SD media must not expose Chakshu hardware controls');
  assert.match(nodes.moduleStatus.textContent, /SD card ready/);
  assert.match(nodes.moduleStatus.textContent, /Offline WAV recordings appear in Memories/);
});
test('old and unknown descriptors do not claim an SD result; Chakshu ignores the extension', () => {
  for (const id of [1, 2]) for (const [version, state] of [[0, 0], [2, 1], [1, 255]]) {
    const module = info(id, version, state);
    assert.equal(module.sdDetectionState, null);
    assert.match(render(module).moduleFeatures.children[0].textContent, /update firmware/);
  }
  const module = info(3, 1, 1), nodes = render(module);
  assert.equal(module.sdDetectionState, null);
  assert.equal(nodes.moduleFeatures.children.length, 0);
  assert.equal(nodes.chakshuChecks.hidden, false);
});
