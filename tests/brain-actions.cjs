'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'brain-ui.js'), 'utf8');
const context = {
  console, Date, JSON, Promise, Object, Array, String, Number, Boolean, Math, Map, Set,
  setTimeout, clearTimeout,
  document: {
    readyState: 'loading',
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  },
  globalThis: null
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'brain-ui.js' });

const api = context.SynapBrainUI;
assert(api, 'brain UI should expose its derivation contract');

const current = {
  id: 'r1',
  createdAt: '2026-09-09T08:00:00+05:30',
  name: 'Launch meeting',
  meeting: {
    people: [{ name: 'Ankit', role: 'colleague' }],
    topics: ['launch'],
    conversations: [{
      title: 'Launch plan',
      start_ms: 0,
      end_ms: 60000,
      people: [],
      topics: ['launch'],
      decisions: [{ text: 'Ship on Friday', start_ms: 1000, end_ms: 2000 }],
      action_items: [
        { task: 'Send deck', owner: 'self', due_date: '2026-09-10', start_ms: 3000, end_ms: 4000 },
        { task: 'Confirm venue', owner: 'Ankit', due_date: null, start_ms: 5000, end_ms: 6000 }
      ],
      follow_ups: [{ text: 'Check vendor quote', owner: 'Ankit', start_ms: 7000, end_ms: 8000 }]
    }]
  }
};

const derived = api.derive([current]);
assert.equal(derived.decisions.length, 1, 'conversation decisions should populate Actions');
assert.equal(derived.my.length, 1, 'self-owned conversation actions should populate commitments');
assert.equal(derived.waiting.length, 2, 'other-owned actions and follow-ups should populate waiting');
assert.equal(derived.decisions[0].text, 'Ship on Friday');
assert.equal(derived.my[0].text, 'Send deck');
assert(derived.waiting.some(item => item.text === 'Confirm venue'));
assert(derived.waiting.some(item => item.text === 'Check vendor quote'));

const legacy = {
  id: 'r2',
  createdAt: '2026-09-09T09:00:00+05:30',
  meeting: {
    decisions: ['Keep legacy support'],
    action_items: [{ task: 'Legacy task', owner: 'self', due_date: null }],
    follow_ups: ['Legacy follow-up']
  }
};
const legacyDerived = api.derive([legacy]);
assert.equal(legacyDerived.decisions[0].text, 'Keep legacy support');
assert(legacyDerived.my.some(item => item.text === 'Legacy task'));
assert(legacyDerived.waiting.some(item => item.text === 'Legacy follow-up'));

console.log('PASS: Actions reads current conversation memory schema and remains legacy-compatible.');
