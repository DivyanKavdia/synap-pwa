import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { Firestore } from '@google-cloud/firestore';
import { generateDek, openJson, sealJson, sealText } from '../src/crypto/envelope.js';
import { keyring } from '../src/crypto/keyring.js';
import { indexMemory } from '../src/pipeline/index-memory.js';
import { processRecording } from '../src/pipeline/process.js';
import {
  claimProcessing,
  patchProcessing,
  patchRecording,
  setFirestoreForTest,
} from '../src/store/firestore.js';
import type { RecordingDoc, StructuredMemory } from '../src/store/types.js';
import { nameKey } from '../src/util/ids.js';

// A transactional store double stages every write until commit and rejects any
// read after a write. Faults exercise production publication/processing methods;
// this is not a claim to replace Firestore emulator or device integration tests.
function database() {
  type Row = Record<string, any>;
  const rows = new Map<string, Row>();
  let failCommit = false,
    failDay = false,
    replay: (() => void) | null = null;
  class Ref {
    constructor(
      readonly path: string,
      readonly filters: [string, string, unknown][] = [],
      readonly sorting = '',
      readonly maximum = Infinity,
    ) {}
    get id() {
      return this.path.split('/').at(-1)!;
    }
    collection(key: string) {
      return new Ref(`${this.path}/${key}`);
    }
    doc(key: string) {
      return new Ref(`${this.path}/${key}`);
    }
    where(field: string, op: string, value: unknown) {
      return new Ref(this.path, [...this.filters, [field, op, value]], this.sorting, this.maximum);
    }
    orderBy(field: string) {
      return new Ref(this.path, this.filters, field, this.maximum);
    }
    limit(maximum: number) {
      return new Ref(this.path, this.filters, this.sorting, maximum);
    }
    async get(): Promise<any> {
      if (this.path.split('/').length % 2 === 0)
        return {
          id: this.id,
          ref: this,
          exists: rows.has(this.path),
          data: () => structuredClone(rows.get(this.path)),
        };
      let values = [...rows].filter(
        ([path, row]) =>
          path.startsWith(this.path + '/') &&
          path.split('/').length === this.path.split('/').length + 1 &&
          this.filters.every(([key, op, value]) =>
            op === 'array-contains' ? row[key]?.includes(value) : row[key] === value,
          ),
      );
      if (this.sorting)
        values = values.sort((a, b) =>
          String(a[1][this.sorting]).localeCompare(String(b[1][this.sorting])),
        );
      const docs = values
        .slice(0, this.maximum)
        .map(([path, row]) => ({
          id: path.split('/').at(-1)!,
          ref: new Ref(path),
          data: () => structuredClone(row),
        }));
      return { docs, empty: !docs.length };
    }
    async set(data: Row, options?: { merge?: boolean }) {
      if (failDay && this.path.includes('/days/')) {
        failDay = false;
        throw Error('Day storage unavailable');
      }
      rows.set(this.path, { ...(options?.merge ? rows.get(this.path) : {}), ...data });
    }
    async update(data: Row) {
      if (!rows.has(this.path)) throw Object.assign(Error('NOT_FOUND'), { code: 5 });
      await this.set(data, { merge: true });
    }
  }
  const store = {
    collection: (key: string) => new Ref(key),
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const writes: (() => Promise<unknown>)[] = [];
      const tx = {
        get: (ref: Ref) => {
          assert.equal(writes.length, 0, 'transaction reads precede every write');
          return ref.get();
        },
        set: (ref: Ref, data: Row, options?: { merge?: boolean }) =>
          writes.push(() => ref.set(data, options)),
        update: (ref: Ref, data: Row) => writes.push(() => ref.update(data)),
        delete: (ref: Ref) => writes.push(async () => rows.delete(ref.path)),
      };
      const result = await fn(tx);
      if (replay) {
        const change = replay;
        replay = null;
        change();
        return store.runTransaction(fn);
      }
      if (failCommit) {
        failCommit = false;
        throw Error('Commit unavailable');
      }
      const before = new Map(rows);
      try {
        for (const write of writes) await write();
      } catch (cause) {
        rows.clear();
        for (const [key, value] of before) rows.set(key, value);
        throw cause;
      }
      return result;
    },
  };
  return {
    rows,
    store: store as unknown as Firestore,
    failNextCommit() {
      failCommit = true;
    },
    failNextDay() {
      failDay = true;
    },
    replay(change: () => void) {
      replay = change;
    },
  };
}
const uid = 'owner',
  recordingId = 'take',
  recordingPath = `users/${uid}/recordings/${recordingId}`;
const binding = (scope: string, field: string) => ({ uid, scope, field });
const person = {
  name: 'Alex',
  role: 'colleague',
  evidence: 'Alex will send the brief.',
  confidence: 0.9,
};
const memory = {
  schema_version: 1,
  title: 'Launch',
  executive_summary: 'We agreed on Friday.',
  key_points: [],
  people: [person, person],
  topics: ['launch'],
  conversations: [
    {
      title: 'Launch',
      summary: 'We agreed on Friday.',
      start_ms: 0,
      end_ms: 10000,
      people: [person],
      topics: ['launch'],
      decisions: [],
      action_items: [
        { task: 'Send the brief', owner: 'Alex', due_date: null, start_ms: 2000, end_ms: 3000 },
      ],
      follow_ups: [],
    },
  ],
} as unknown as StructuredMemory;
function fixture() {
  const db = database(),
    dek = generateDek();
  const recording = {
    recordingId,
    day: '2026-09-13',
    timezone: 'UTC',
    startedAt: '2026-09-13T10:00:00Z',
    state: 'indexing',
    progress: 0.8,
    processingLease: 'lease',
    segmentCount: 1,
    durationMs: 10000,
    updatedAt: new Date().toISOString(),
    sealedMemory: sealJson(dek, memory, binding(`recording/${recordingId}`, 'memory')),
    sealedTranscript: sealText(
      dek,
      '[00:02] S1: Alex will send the brief.',
      binding(`recording/${recordingId}`, 'transcript'),
    ),
  } as RecordingDoc;
  db.rows.set(recordingPath, recording);
  db.rows.set(`users/${uid}`, { uid, key: {} });
  setFirestoreForTest(db.store);
  process.env.SYNAP_DISABLE_VECTOR_INDEX = '1';
  return {
    ...db,
    dek,
    recording,
    list: (collection: string) =>
      [...db.rows]
        .filter(([key]) => key.startsWith(`users/${uid}/${collection}/`))
        .map(([, value]) => value),
  };
}
test.afterEach(() => {
  setFirestoreForTest(null);
  mock.restoreAll();
  delete process.env.SYNAP_DISABLE_VECTOR_INDEX;
});

test('failed publication rolls back all derived writes; retry keeps completed tasks and counts once', async () => {
  const f = fixture();
  f.failNextCommit();
  await assert.rejects(indexMemory(uid, f.dek, f.recording, memory, 'lease'), /Commit unavailable/);
  assert.equal(f.list('people').length, 0);
  assert.equal(f.list('followUps').length, 0);
  assert.equal(f.rows.get(recordingPath)!.state, 'indexing');
  await indexMemory(uid, f.dek, f.recording, memory, 'lease');
  const task = f.list('followUps')[0]!;
  task.state = 'done';
  f.rows.set(`users/${uid}/followUps/${task.followUpId}`, task);
  f.rows.set(recordingPath, { ...f.rows.get(recordingPath), state: 'failed' });
  mock.method(keyring, 'unwrap', async () => f.dek);
  mock.method(globalThis, 'fetch', async () => {
    throw Error('Retry must not call a model');
  });
  await processRecording(uid, recordingId);
  assert.equal(f.list('followUps').length, 1);
  assert.equal(f.list('followUps')[0]!.state, 'done');
  assert.equal(f.list('people')[0]!.conversationCount, 1);
  assert.equal(f.rows.get(recordingPath)!.state, 'ready');
});

test('legacy duplicate tasks reconcile without losing completion or confirmed names', async () => {
  const f = fixture(),
    key = nameKey(f.dek, 'Alex'),
    personId = 'confirmed';
  f.rows.set(`users/${uid}/people/${personId}`, {
    personId,
    nameKey: key,
    aliasKeys: [key],
    conversationCount: 4,
    confirmedByUser: true,
    firstSeenAt: '2026-01-01',
    lastInteractionAt: '2026-09-12',
    sealedProfile: sealJson(
      f.dek,
      { name: 'Alex Rivera', role: 'my confirmed role' },
      binding(`person/${personId}`, 'profile'),
    ),
  });
  f.rows.set(`users/${uid}/conversations/legacy`, {
    conversationId: 'legacy',
    recordingId,
    personIds: [personId],
  });
  for (const [followUpId, state] of [
    ['old-open', 'open'],
    ['old-done', 'done'],
  ])
    f.rows.set(`users/${uid}/followUps/${followUpId}`, {
      followUpId,
      state,
      recordingId,
      conversationId: 'legacy',
      startMs: 2000,
      createdAt: '2026-09-12',
      updatedAt: '2026-09-12',
      sealedTask: sealJson(
        f.dek,
        { task: 'Send the brief', owner: 'Alex', kind: 'commitment' },
        binding(`followUp/${followUpId}`, 'task'),
      ),
    });
  await indexMemory(uid, f.dek, f.recording, memory, 'lease');
  assert.equal(f.list('followUps').length, 1);
  assert.equal(f.list('followUps')[0]!.followUpId, 'old-done');
  const stored = f.list('people')[0]!;
  assert.equal(stored.conversationCount, 4);
  assert.deepEqual(
    openJson(f.dek, stored.sealedProfile, binding(`person/${personId}`, 'profile')),
    { name: 'Alex Rivera', role: 'my confirmed role' },
  );
  assert(!f.rows.has(`users/${uid}/conversations/legacy`));
  assert.equal(f.list('followUps')[0]!.conversationId, f.list('conversations')[0]!.conversationId);
});

test('a transaction replay observes a concurrent task completion', async () => {
  const f = fixture();
  await indexMemory(uid, f.dek, f.recording, memory, 'lease');
  const task = f.list('followUps')[0]!;
  const source = {
    ...f.rows.get(recordingPath),
    processingLease: 'next',
    indexedMemoryRevision: null,
    state: 'indexing',
  } as RecordingDoc;
  f.rows.set(recordingPath, source);
  f.replay(() =>
    f.rows.set(`users/${uid}/followUps/${task.followUpId}`, { ...task, state: 'dismissed' }),
  );
  await indexMemory(uid, f.dek, source, memory, 'next');
  assert.equal(f.list('followUps')[0]!.state, 'dismissed');
  assert.equal(f.list('people')[0]!.conversationCount, 1);
});

test('claims reject overlapping workers and stale workers cannot change or publish the result', async () => {
  const f = fixture();
  await assert.rejects(claimProcessing(uid, recordingId, 'overlap'), /already processing/);
  f.rows.set(recordingPath, { ...f.recording, updatedAt: '2026-01-01' });
  await claimProcessing(uid, recordingId, 'new-owner');
  await assert.rejects(
    patchProcessing(uid, recordingId, 'lease', { state: 'failed' }),
    /superseded/,
  );
  await assert.rejects(indexMemory(uid, f.dek, f.recording, memory, 'lease'), /superseded/);
  assert.equal(f.list('people').length, 0);
});

test('deletion and changed memory invalidate publication without recreating documents', async () => {
  for (const mutation of ['delete', 'deleting', 'changed']) {
    const f = fixture();
    if (mutation === 'delete') f.rows.delete(recordingPath);
    else
      f.rows.set(recordingPath, {
        ...f.recording,
        ...(mutation === 'deleting'
          ? { deleting: true }
          : {
              sealedMemory: sealJson(
                f.dek,
                { ...memory, title: 'Changed' },
                binding(`recording/${recordingId}`, 'memory'),
              ),
            }),
      });
    await assert.rejects(
      indexMemory(uid, f.dek, f.recording, memory, 'lease'),
      /Unknown recording|Memory changed/,
    );
    assert.equal(f.list('followUps').length, 0);
    if (mutation === 'delete') {
      await assert.rejects(patchRecording(uid, recordingId, { state: 'failed' }), /NOT_FOUND/);
      assert(!f.rows.has(recordingPath));
    }
  }
});

test('a brief failure leaves the recording ready and the retry only rebuilds the day', async () => {
  const f = fixture();
  f.rows.set(recordingPath, { ...f.recording, state: 'failed' });
  mock.method(keyring, 'unwrap', async () => f.dek);
  mock.method(globalThis, 'fetch', async () => {
    throw Error('Cached understanding must not call a model');
  });
  f.failNextDay();
  await assert.rejects(processRecording(uid, recordingId), /Day storage unavailable/);
  assert.equal(f.rows.get(recordingPath)!.state, 'ready');
  const before = JSON.stringify(f.list('followUps'));
  await processRecording(uid, recordingId);
  assert.equal(JSON.stringify(f.list('followUps')), before);
  assert.equal(f.list('people')[0]!.conversationCount, 1);
  assert(f.rows.has(`users/${uid}/days/2026-09-13`));
});
