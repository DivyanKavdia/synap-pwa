'use strict';
/* Restoring history from the cloud.
 *
 * The dangerous direction is cloud-over-local: the journal is the only copy of
 * a recording that has not finished uploading, so a restore that overwrote it
 * would destroy audio that cannot be recovered from anywhere. Every assertion
 * below is about that boundary.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'cloud-history.js'), 'utf8');
const backendSource = fs.readFileSync(path.join(root, 'synap-backend.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

function load(overrides) {
  const context = Object.assign(
    {
      console, Date, JSON, Error, Map, Set, Promise, Object, Array, String, Number,
      Boolean, Math, Intl, setTimeout, clearTimeout,
      // readyState 'loading' keeps init() deferred, so importing the module
      // never touches IndexedDB or the network.
      document: { readyState: 'loading', addEventListener() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    },
    overrides || {},
  );
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'cloud-history.js' });
  return context;
}

const api = load().SynapCloudHistory;
assert.ok(api, 'the module exports its testable surface');

// ---------------------------------------------------------------------------
// merge: local always wins
// ---------------------------------------------------------------------------

{
  // The case that matters most: a recording still holding un-uploaded audio.
  const local = { id: 'r1', blob: { size: 4096 }, transcript: 'local words', processingState: 'pending' };
  const restored = { id: 'r1', transcript: 'cloud words', summary: 'cloud summary', processingState: 'done' };
  const merged = api.merge(local, restored);

  assert.deepEqual(merged.blob, { size: 4096 }, 'local audio survives a restore');
  assert.equal(merged.transcript, 'local words', 'a local transcript is not replaced');
  assert.equal(merged.processingState, 'pending', 'in-flight local state is not overwritten as done');
  assert.equal(merged.summary, 'cloud summary', 'a field local does not have is filled in');
}

{
  // Empty strings and empty arrays count as missing, which is how a
  // half-populated local record gets completed rather than left blank.
  const local = { id: 'r2', transcript: '', summary: '', people: [], name: 'Morning' };
  const restored = { id: 'r2', transcript: 'restored', summary: 'restored summary', people: [{ name: 'Ankit' }], name: 'Cloud name' };
  const merged = api.merge(local, restored);

  assert.equal(merged.transcript, 'restored');
  assert.equal(merged.summary, 'restored summary');
  assert.deepEqual(merged.people, [{ name: 'Ankit' }]);
  assert.equal(merged.name, 'Morning', 'a name the user already has is kept');
}

{
  // null and undefined are missing; false and 0 are real values a restore
  // must not trample.
  const local = { id: 'r3', notes: null, durationMs: 0, processingRetryable: false };
  const restored = { id: 'r3', notes: 'from cloud', durationMs: 90000, processingRetryable: true };
  const merged = api.merge(local, restored);

  assert.equal(merged.notes, 'from cloud', 'null is treated as missing');
  assert.equal(merged.durationMs, 0, 'a real zero is not overwritten');
  assert.equal(merged.processingRetryable, false, 'a real false is not overwritten');
}

// ---------------------------------------------------------------------------
// toLocal: an honest record for something whose audio no longer exists
// ---------------------------------------------------------------------------

{
  const withBackend = load({
    SynapBackend: {
      toRecordingFields: (memory) => ({
        name: memory.title,
        summary: 'built summary',
        meeting: memory,
        people: memory.people || [],
        conversations: memory.conversations || [],
        processingState: 'done',
      }),
    },
  }).SynapCloudHistory;

  const record = withBackend.toLocal({
    recording_id: 'abc',
    started_at: '2026-09-01T10:00:00.000Z',
    duration_ms: 125000,
    state: 'ready',
    title: 'Standup',
    people: [{ name: 'Divyan' }],
    conversations: [],
    transcript: 'hello there',
  });

  assert.equal(record.id, 'abc');
  assert.equal(record.createdAt, '2026-09-01T10:00:00.000Z');
  assert.equal(record.durationMs, 125000);
  assert.equal(record.name, 'Standup');
  assert.equal(record.transcript, 'hello there');
  assert.equal(record.processingState, 'done');

  // Cloud audio expires after 30 days and is not downloadable. Inventing a blob
  // or a size would give the user a Play button that fails.
  assert.equal(record.blob, undefined, 'no audio is fabricated');
  assert.equal(record.sizeBytes, 0);
  assert.equal(record.restoredFromCloud, true, 'the record is marked as restored');
}

{
  // Still processing in the cloud: shown as pending, not as an empty memory.
  const record = api.toLocal({
    recording_id: 'pending-1',
    started_at: '2026-09-02T08:00:00.000Z',
    duration_ms: 30000,
    state: 'transcribing',
  });

  assert.equal(record.processingState, 'pending');
  assert.equal(record.processingStage, 'transcribing');
  assert.equal(record.summary, '');
  assert.ok(record.name, 'a record with no title still gets a readable name');
}

{
  // Defensive: a malformed payload must not throw inside the restore loop and
  // abandon every later recording.
  const record = api.toLocal({ recording_id: 'sparse' });
  assert.equal(record.id, 'sparse');
  assert.equal(record.durationMs, 0);
  assert.ok(record.createdAt, 'a missing start time still yields a sortable record');
}

// ---------------------------------------------------------------------------
// plan: when it is worth spending the user's data
// ---------------------------------------------------------------------------

{
  const withPlan = load().SynapCloudHistory;
  assert.equal(typeof withPlan.plan, 'function', 'plan is exported for testing');

  // The case this feature exists for: a device that knows nothing.
  const fresh = withPlan.plan([], false);
  assert.equal(fresh.fetch, true, 'an empty journal always pulls');
  assert.equal(fresh.transcript, true, 'and pulls transcripts, because nothing here has them');

  // A populated journal only needs to hear about recordings made elsewhere.
  // Transcripts are the bulk of the payload and are not worth re-downloading.
  const populated = withPlan.plan([{ id: 'a' }], false);
  assert.equal(populated.fetch, true, 'a populated journal still checks for recordings made elsewhere');
  assert.equal(populated.transcript, false, 'but does not re-download every transcript');
}

{
  // Once synced this session, opening the app again costs nothing.
  const synced = load({
    sessionStorage: { getItem: (k) => (k === 'synap-cloud-history-synced' ? '1' : null), setItem() {}, removeItem() {} },
  }).SynapCloudHistory;

  assert.equal(synced.plan([{ id: 'a' }], false).fetch, false, 'a second app open this session costs nothing');
  // ...but a fresh sign-in forces it anyway, because that is exactly when
  // history is expected to reappear.
  assert.equal(synced.plan([{ id: 'a' }], true).fetch, true, 'a fresh sign-in forces a sync anyway');
  // An empty journal always pulls, session marker or not: this is the
  // post-sign-out case on the user's own phone.
  const afterSignOut = synced.plan([], false);
  assert.equal(afterSignOut.fetch, true, 'an empty journal pulls even if the session marker is set');
  assert.equal(afterSignOut.transcript, true);
}

// ---------------------------------------------------------------------------
// busy: never reload over a live recording
// ---------------------------------------------------------------------------

for (const state of ['recording', 'starting', 'stopping', 'saving', 'updating']) {
  const ctx = load({ document: { readyState: 'loading', addEventListener() {}, body: { dataset: { state } } } });
  assert.equal(ctx.SynapCloudHistory.busy(), true, `${state} must block the reload`);
}

for (const state of ['idle', 'connected', '', undefined]) {
  const ctx = load({ document: { readyState: 'loading', addEventListener() {}, body: { dataset: { state } } } });
  assert.equal(ctx.SynapCloudHistory.busy(), false, `${state} is safe to reload through`);
}

{
  // No body at all (very early startup) must not throw.
  assert.equal(load().SynapCloudHistory.busy(), false);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

assert.match(html, /src="cloud-history\.js/);
assert.match(sw, /\.\/cloud-history\.js/);
assert.match(backendSource, /recordings:function\(options\)/);
assert.match(backendSource, /include_transcript=true/);
// The list must be a read. A restore that could delete server-side history
// would turn a convenience into a hazard.
assert.doesNotMatch(source, /method:\s*['"](DELETE|POST|PUT|PATCH)['"]/);
// audio-store.js owns this database at version 3. Opening it here directly
// could create a version-1 database with no object stores on a browser that
// has never run Synap, breaking the app for good.
{
  // Strip comments: the file explains why it avoids indexedDB.open, and the
  // explanation must not fail the check it is describing.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /indexedDB\.open/);
  assert.match(code, /new root\.DKAudioStore/);
}

console.log('PASS: cloud restore never overwrites local audio or in-flight state, fabricates no audio, and only reads');
