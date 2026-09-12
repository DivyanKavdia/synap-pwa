'use strict';
/* The people confirm/rename control.
 *
 * The failure mode worth guarding is silent: if the PWA's name normalization
 * ever drifts from the backend's, no card is matched to a person id, no
 * controls appear, and nothing throws. So the normalizer is pinned against the
 * backend's own implementation rather than against a copy of it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'people-confirm-ui.js'), 'utf8');
assert.match(source,/if\(!button\|\|button\.type==='submit'\)return;event\.preventDefault\(\)/,'Save clicks must reach the native rename form submit event');
const backendClient = fs.readFileSync(path.join(root, 'synap-backend.js'), 'utf8');
const backendIds = fs.readFileSync(path.join(root, 'backend/src/util/ids.ts'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const context = {
  console, Map, Set, Promise, Number, String, Boolean, Array, Object, Math, Date, RegExp,
  setTimeout, clearTimeout,
  MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  addEventListener: () => {},
  document: null
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'people-confirm-ui.js' });

const api = context.SynapPeopleConfirmUI;
assert.ok(api, 'the module exports its testable surface');

// ---------------------------------------------------------------------------
// Normalization must agree with the backend, character for character
// ---------------------------------------------------------------------------

/* Lifted out of backend/src/util/ids.ts at test time rather than transcribed,
   so editing one side without the other fails here instead of in production. */
const backendNormalize = (() => {
  const match = backendIds.match(/export function normalizeName\(name: string\): string \{([\s\S]*?)\n\}/);
  assert.ok(match, 'backend normalizeName is still where this test expects it');
  const body = match[1].replace(/: string/g, '');
  return new Function('name', body + '\n');
})();

const NAMES = [
  'Ankit', 'ankit', '  Ankit  ', 'Ankit Sharma', 'ANKIT   SHARMA',
  'José', 'Jose', "O'Brien", 'Mary-Jane', 'Dr. Rao', 'Rao, Dr.',
  '李雷', 'Ana Sofía', 'jean‑luc', '  ', '123', 'A. B. C.'
];

for (const name of NAMES) {
  assert.equal(
    api.normalize(name),
    backendNormalize(name),
    `normalization drifted from the backend for ${JSON.stringify(name)}`
  );
}

// The specific cases the matching depends on.
assert.equal(api.normalize('  ANKIT   Sharma '), 'ankit sharma');
assert.equal(api.normalize("O'Brien"), 'obrien');
assert.equal(api.normalize('José'), 'jose');
assert.equal(api.normalize(null), '');
assert.equal(api.normalize(undefined), '');

// ---------------------------------------------------------------------------
// Indexing the /v1/people response
// ---------------------------------------------------------------------------

{
  const index = api.indexPeople({
    people: [
      { person_id: 'p1', name: 'Ankit Sharma', confirmed_by_user: false },
      { person_id: 'p2', name: 'Divyan', confirmed_by_user: true }
    ]
  });
  assert.equal(index.size, 2);
  assert.equal(index.get('ankit sharma').person_id, 'p1');
  assert.equal(index.get('divyan').confirmed_by_user, true);
}

{
  // A card can only be wired to a control if there is an id to PATCH.
  const index = api.indexPeople({ people: [{ name: 'No Id Here' }] });
  assert.equal(index.size, 0);
}

{
  // A person whose name normalizes to nothing must not claim the empty key and
  // shadow every unmatched card.
  const index = api.indexPeople({ people: [{ person_id: 'p3', name: '   ' }] });
  assert.equal(index.size, 0);
}

{
  // Absent, empty and malformed payloads are all "no people", not a throw:
  // this runs on every render of the people list.
  assert.equal(api.indexPeople(null).size, 0);
  assert.equal(api.indexPeople({}).size, 0);
  assert.equal(api.indexPeople({ people: [] }).size, 0);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

assert.match(html, /src="people-confirm-ui\.js/);
// Renaming has to reach the backend, and has to be a PATCH on the person.
assert.match(backendClient, /renamePerson:function\(personId,name\)/);
assert.match(backendClient, /'\/v1\/people\/'\+encodeURIComponent\(personId\)/);
// Correcting a name is the whole mechanism. This control must never start
// capturing a voice sample, which would turn a UI tweak into the collection of
// biometric data — a decision that belongs to a spec review, not to this file.
assert.doesNotMatch(
  source.replace(/\/\*[\s\S]*?\*\//g, ''),
  /getUserMedia|AudioContext|MediaRecorder|voiceprint|speakerEmbedding/i
);

console.log('PASS: people confirm/rename normalization matches the backend, indexing is defensive, and the control is wired into the shell');

// Canonical IDs remain unambiguous even for duplicate or non-Latin names.
{
  const index=api.indexPeople({people:[{person_id:'p4',name:'Alex'},{person_id:'p5',name:'Alex'},{person_id:'p6',name:'李雷'}]});
  assert.equal(index.byId.get('p4').name,'Alex');assert.equal(index.byId.get('p5').name,'Alex');assert.equal(index.byId.get('p6').name,'李雷');
  assert.equal(index.has(''),false);
}
