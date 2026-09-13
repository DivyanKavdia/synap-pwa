import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { generateDek, sealJson, sealText } from '../../src/crypto/envelope.js';
import { indexMemory } from '../../src/pipeline/index-memory.js';
import {
  claimProcessing,
  getRecording,
  patchFollowUp,
  patchProcessing,
  paths,
  setFirestoreForTest,
} from '../../src/store/firestore.js';
import type { RecordingDoc, StructuredMemory } from '../../src/store/types.js';

// This command refuses to run against a cloud database, even with credentials
// in the environment. The CI job has no auth step and a disposable demo project.
assert.match(
  process.env.FIRESTORE_EMULATOR_HOST || '',
  /^(127\.0\.0\.1|localhost):\d+$/,
  'A local Firestore emulator is required',
);
const store = new Firestore({ projectId: 'demo-synap-readiness', ignoreUndefinedProperties: true });
setFirestoreForTest(store);
process.env.SYNAP_DISABLE_VECTOR_INDEX = '1';
const uid = 'qa-' + randomUUID(),
  dek = generateDek();
const person = { name: 'Maya', role: 'colleague', evidence: 'Maya spoke.', confidence: 0.9 };
const memory = {
  schema_version: 1,
  title: 'Pilot',
  executive_summary: 'Pilot agreed.',
  key_points: [],
  people: [person],
  topics: ['pilot'],
  conversations: [
    {
      title: 'Pilot',
      summary: 'Pilot agreed.',
      start_ms: 0,
      end_ms: 10000,
      people: [person],
      topics: ['pilot'],
      decisions: [],
      action_items: [
        { task: 'Send invitations', owner: 'self', due_date: null, start_ms: 1000, end_ms: 2000 },
      ],
      follow_ups: [],
    },
  ],
} as unknown as StructuredMemory;
async function seed(id: string) {
  const recording = {
    recordingId: id,
    day: '2026-09-13',
    timezone: 'UTC',
    startedAt: '2026-09-13T10:00:00Z',
    durationMs: 10000,
    state: 'uploaded',
    progress: 0,
    updatedAt: new Date().toISOString(),
    sealedMemory: sealJson(dek, memory, { uid, scope: `recording/${id}`, field: 'memory' }),
    sealedTranscript: sealText(dek, '[00:01] YOU: I will send invitations.', {
      uid,
      scope: `recording/${id}`,
      field: 'transcript',
    }),
  } as RecordingDoc;
  await paths.recording(uid, id).set(recording);
  return recording;
}
test.after(async () => {
  await store.recursiveDelete(paths.user(uid));
  await store.terminate();
  setFirestoreForTest(null);
});

test(
  'Firestore serializes competing claims and commits one complete index',
  { timeout: 90000 },
  async () => {
    const id = 'competing';
    await seed(id);
    const claims = await Promise.allSettled(
      ['a', 'b', 'c'].map((lease) => claimProcessing(uid, id, lease)),
    );
    assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1);
    const source = (await getRecording(uid, id))!;
    await indexMemory(uid, dek, source, memory, source.processingLease!);
    assert.equal((await getRecording(uid, id))!.state, 'ready');
    const tasks = await paths.followUps(uid).where('recordingId', '==', id).get();
    assert.equal(tasks.size, 1);
    await patchFollowUp(uid, tasks.docs[0]!.id, { state: 'done' });
    await claimProcessing(uid, id, 'resume', true);
    await indexMemory(uid, dek, (await getRecording(uid, id))!, memory, 'resume');
    assert.equal((await paths.followUps(uid).doc(tasks.docs[0]!.id).get()).data()!.state, 'done');
    assert.equal((await paths.people(uid).get()).docs[0]!.data().conversationCount, 1);
  },
);

test(
  'concurrent recordings reuse one person and preserve every recording contribution',
  { timeout: 90000 },
  async () => {
    const before = (await paths.people(uid).get()).docs[0]!.data().conversationCount;
    await Promise.all(
      ['one', 'two'].map(async (id) => {
        await seed(id);
        await claimProcessing(uid, id, id);
        await indexMemory(uid, dek, (await getRecording(uid, id))!, memory, id);
      }),
    );
    const people = await paths.people(uid).get();
    assert.equal(people.size, 1);
    assert.equal(people.docs[0]!.data().conversationCount, before + 2);
  },
);

test(
  'superseded and deleted records reject late publication through the real SDK',
  { timeout: 90000 },
  async () => {
    const id = 'cancelled';
    await seed(id);
    await claimProcessing(uid, id, 'old');
    const old = (await getRecording(uid, id))!;
    await paths.recording(uid, id).update({ processingLease: 'new' });
    await assert.rejects(indexMemory(uid, dek, old, memory, 'old'), /superseded/);
    await assert.rejects(patchProcessing(uid, id, 'old', { state: 'failed' }), /superseded/);
    await paths.recording(uid, id).delete();
    await assert.rejects(indexMemory(uid, dek, old, memory, 'old'), /Unknown recording/);
    assert.equal((await paths.conversations(uid).where('recordingId', '==', id).get()).size, 0);
    assert.equal((await paths.followUps(uid).where('recordingId', '==', id).get()).size, 0);
  },
);

test('concurrent upload retries accept one immutable source and count it once', {timeout:90000}, async()=>{
  const db=await import('../../src/store/firestore.js');
  const id='immutable';
  const recording={...(await seed(id)),state:'created',createdAt:'first',endedAt:null,uploadedSegments:0} as RecordingDoc;
  await paths.recording(uid,id).set(recording);
  const source={index:0,startMs:0,endMs:1000,sha256:'first',bytes:32044,storagePath:'attempt-one',state:'accepted',sealedTranscript:null,sealedWords:null,language:null,uploadedAt:'now',transcribedAt:null} as import('../../src/store/types.js').SegmentDoc;
  const results=await Promise.allSettled([
    db.acceptSegment(uid,id,source,'first'),
    db.acceptSegment(uid,id,{...source,storagePath:'retry'},'first'),
    db.acceptSegment(uid,id,{...source,sha256:'different',storagePath:'conflict'},'first'),
  ]);
  const accepted=(await db.getSegment(uid,id,0))!;
  assert.equal((await db.getRecording(uid,id))!.uploadedSegments,1);
  const fulfilled=results.filter(result=>result.status==='fulfilled');
  assert(fulfilled.length>=1&&fulfilled.length<=2);
  for(const result of fulfilled)if(result.status==='fulfilled')assert.deepEqual(result.value,accepted);
  for(const result of results)if(result.status==='rejected')assert.equal(result.reason.status,409);
  const completed={...accepted,state:'transcribed',sealedTranscript:sealText(dek,'Saved',{uid,scope:`recording/${id}/segment/0`,field:'transcript'}),sealedWords:sealJson(dek,[],{uid,scope:`recording/${id}/segment/0`,field:'words'}),transcribedAt:'done'} as typeof source;
  await db.completeSegmentTranscription(uid,id,completed);
  const finalization={endedAt:'done',durationMs:1000,segmentCount:1};
  await Promise.all([db.finalizeRecording(uid,id,finalization),db.finalizeRecording(uid,id,finalization)]);
  await paths.recording(uid,id).update({state:'ready',processingLease:'current'});
  assert.equal((await db.finalizeRecording(uid,id,finalization)).state,'ready');
  assert.equal((await db.getRecording(uid,id))!.processingLease,'current');
  assert.equal((await db.acceptSegment(uid,id,accepted,'first')).state,'transcribed');
  assert.equal((await db.getRecording(uid,id))!.state,'ready');
  const late={...completed,sealedTranscript:sealText(dek,'Late',{uid,scope:`recording/${id}/segment/0`,field:'transcript'})};
  assert.deepEqual((await db.completeSegmentTranscription(uid,id,late)).sealedTranscript,completed.sealedTranscript);
  await db.beginRecordingDeletion(uid,id);
  await assert.rejects(db.completeSegmentTranscription(uid,id,late),{status:404});
  await db.deleteRecording(uid,id);
  await assert.rejects(db.acceptSegment(uid,id,accepted,'first'),{status:404});
  await assert.rejects(db.completeSegmentTranscription(uid,id,late),{status:404});
  assert.equal((await paths.segments(uid,id).get()).size,0);
});
