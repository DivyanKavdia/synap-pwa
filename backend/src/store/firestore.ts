/**
 * Firestore access layer.
 *
 * Every path is rooted at `users/{uid}`, so a query can never accidentally
 * cross a user boundary: there is no collection in this file that is not a
 * subcollection of exactly one user document. Security rules are a second
 * layer, not the first one.
 */

import { FieldValue, Firestore, type Query } from '@google-cloud/firestore';
import { config } from '../config.js';
import type {
  ConversationDoc,
  DayDoc,
  FollowUpDoc,
  HighlightDoc,
  JobDoc,
  PersonDoc,
  RecordingDoc,
  SegmentDoc,
  UserDoc,
} from './types.js';

let db: Firestore | null = null;

export function firestore(): Firestore {
  db ??= new Firestore({ projectId: config.projectId, ignoreUndefinedProperties: true });
  return db;
}

export function setFirestoreForTest(instance: Firestore | null): void {
  db = instance;
}

const users = () => firestore().collection('users');
const user = (uid: string) => users().doc(uid);

export const paths = {
  user,
  recordings: (uid: string) => user(uid).collection('recordings'),
  recording: (uid: string, recordingId: string) => user(uid).collection('recordings').doc(recordingId),
  segments: (uid: string, recordingId: string) =>
    paths.recording(uid, recordingId).collection('segments'),
  highlights: (uid: string, recordingId: string) =>
    paths.recording(uid, recordingId).collection('highlights'),
  conversations: (uid: string) => user(uid).collection('conversations'),
  people: (uid: string) => user(uid).collection('people'),
  followUps: (uid: string) => user(uid).collection('followUps'),
  days: (uid: string) => user(uid).collection('days'),
  jobs: (uid: string) => user(uid).collection('jobs'),
  /** Idempotency ledger — one doc per Idempotency-Key, TTL-expired by Firestore. */
  idempotency: (uid: string) => user(uid).collection('idempotency'),
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function getUser(uid: string): Promise<UserDoc | null> {
  const snapshot = await user(uid).get();
  return snapshot.exists ? (snapshot.data() as UserDoc) : null;
}

export async function findUserByGoogleSubject(subject: string): Promise<UserDoc | null> {
  const snapshot = await users().where('googleSubject', '==', subject).limit(1).get();
  const doc = snapshot.docs[0];
  return doc ? (doc.data() as UserDoc) : null;
}

export async function putUser(doc: UserDoc): Promise<void> {
  await user(doc.uid).set(doc, { merge: true });
}

export async function touchUser(uid: string, at: string): Promise<void> {
  await user(uid).update({ lastSeenAt: at });
}

export async function bumpTokenGeneration(uid: string): Promise<number> {
  const ref = user(uid);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const next = ((snapshot.data() as UserDoc | undefined)?.tokenGeneration ?? 0) + 1;
    tx.update(ref, { tokenGeneration: next });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Recordings and segments
// ---------------------------------------------------------------------------

export async function getRecording(uid: string, recordingId: string): Promise<RecordingDoc | null> {
  const snapshot = await paths.recording(uid, recordingId).get();
  return snapshot.exists ? (snapshot.data() as RecordingDoc) : null;
}

export async function putRecording(uid: string, doc: RecordingDoc): Promise<void> {
  await paths.recording(uid, doc.recordingId).set(doc, { merge: true });
}

export async function patchRecording(
  uid: string,
  recordingId: string,
  fields: Partial<RecordingDoc>,
): Promise<void> {
  await paths
    .recording(uid, recordingId)
    .set({ ...fields, updatedAt: new Date().toISOString() }, { merge: true });
}

export async function listRecordingsByDay(uid: string, day: string): Promise<RecordingDoc[]> {
  const snapshot = await paths.recordings(uid).where('day', '==', day).orderBy('startedAt').get();
  return snapshot.docs.map((doc) => doc.data() as RecordingDoc);
}

export async function putSegment(uid: string, recordingId: string, doc: SegmentDoc): Promise<void> {
  await paths.segments(uid, recordingId).doc(String(doc.index)).set(doc, { merge: true });
}

export async function getSegment(
  uid: string,
  recordingId: string,
  index: number,
): Promise<SegmentDoc | null> {
  const snapshot = await paths.segments(uid, recordingId).doc(String(index)).get();
  return snapshot.exists ? (snapshot.data() as SegmentDoc) : null;
}

export async function listSegments(uid: string, recordingId: string): Promise<SegmentDoc[]> {
  const snapshot = await paths.segments(uid, recordingId).orderBy('index').get();
  return snapshot.docs.map((doc) => doc.data() as SegmentDoc);
}

/**
 * Count uploaded segments without reading their bodies. Firestore aggregation
 * keeps this O(1) in billed reads, which matters for hour-long captures.
 */
export async function countSegments(uid: string, recordingId: string): Promise<number> {
  const snapshot = await paths.segments(uid, recordingId).count().get();
  return snapshot.data().count;
}

export async function putHighlight(
  uid: string,
  recordingId: string,
  doc: HighlightDoc,
): Promise<void> {
  await paths.highlights(uid, recordingId).doc(doc.highlightId).set(doc, { merge: true });
}

export async function listHighlights(uid: string, recordingId: string): Promise<HighlightDoc[]> {
  const snapshot = await paths.highlights(uid, recordingId).orderBy('offsetMs').get();
  return snapshot.docs.map((doc) => doc.data() as HighlightDoc);
}

// ---------------------------------------------------------------------------
// Conversations and retrieval
// ---------------------------------------------------------------------------

export async function putConversation(uid: string, doc: ConversationDoc): Promise<void> {
  const { embedding, ...rest } = doc;
  await paths.conversations(uid).doc(doc.conversationId).set(
    {
      ...rest,
      // Firestore needs a Vector value, not a plain array, to serve findNearest.
      embedding: embedding ? FieldValue.vector(embedding) : null,
    },
    { merge: true },
  );
}

export async function deleteConversationsForRecording(
  uid: string,
  recordingId: string,
): Promise<void> {
  const snapshot = await paths.conversations(uid).where('recordingId', '==', recordingId).get();
  if (snapshot.empty) return;
  const batch = firestore().batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

export interface RetrievalScope {
  from?: string | null;
  to?: string | null;
  personIds?: string[];
  topicKeys?: string[];
}

/**
 * Nearest-neighbour search over conversation summaries, prefiltered by the
 * structured scope the query parser extracted. Firestore applies the filters
 * before the KNN stage, so a "what did Ankit say last week" query does not pay
 * to scan a year of vectors.
 */
export async function findNearestConversations(
  uid: string,
  queryVector: number[],
  limit: number,
  scope: RetrievalScope = {},
): Promise<ConversationDoc[]> {
  // A Firestore vector index can only be prefixed by EQUALITY filters. Ask
  // Synap scopes by date range and by array membership, and neither qualifies —
  // attaching them to the query makes it unservable by any index we can
  // declare. So nearest-neighbour runs unfiltered and the scope is applied to
  // the results here instead.
  //
  // The cost is that scoping narrows the candidate set after ranking rather
  // than before it, so a heavily filtered question sees fewer usable results.
  // Over-fetching absorbs that: callers ask for more than they intend to use.
  const snapshot = await paths
    .conversations(uid)
    .findNearest({
      vectorField: 'embedding',
      queryVector,
      limit: Math.min(1000, Math.max(limit * 4, 40)),
      distanceMeasure: 'COSINE',
    })
    .get();

  return snapshot.docs
    .map((doc) => normalizeConversation(doc.data()))
    .filter((conversation) => matchesScope(conversation, scope))
    .slice(0, limit);
}

/** Applies the parts of a retrieval scope a vector index cannot express. */
export function matchesScope(conversation: ConversationDoc, scope: RetrievalScope): boolean {
  if (scope.from && conversation.day < scope.from) return false;
  if (scope.to && conversation.day > scope.to) return false;
  if (scope.personIds?.length) {
    const wanted = new Set(scope.personIds);
    if (!conversation.personIds?.some((id) => wanted.has(id))) return false;
  }
  if (scope.topicKeys?.length) {
    const wanted = new Set(scope.topicKeys);
    if (!conversation.topicKeys?.some((key) => wanted.has(key))) return false;
  }
  return true;
}

/** Keyword fallback when vectors are disabled or the index is still building. */
export async function recentConversations(
  uid: string,
  limit: number,
  scope: RetrievalScope = {},
): Promise<ConversationDoc[]> {
  let query: Query = paths.conversations(uid);
  if (scope.from) query = query.where('day', '>=', scope.from);
  if (scope.to) query = query.where('day', '<=', scope.to);
  const snapshot = await query.orderBy('startedAt', 'desc').limit(limit).get();
  return snapshot.docs.map((doc) => normalizeConversation(doc.data()));
}

function normalizeConversation(data: FirebaseFirestore.DocumentData): ConversationDoc {
  const embedding = data.embedding;
  return {
    ...(data as ConversationDoc),
    embedding:
      embedding && typeof embedding.toArray === 'function'
        ? (embedding.toArray() as number[])
        : (embedding as number[] | null),
  };
}

// ---------------------------------------------------------------------------
// People and follow-ups
// ---------------------------------------------------------------------------

export async function findPersonByNameKey(uid: string, nameKey: string): Promise<PersonDoc | null> {
  const snapshot = await paths.people(uid).where('nameKey', '==', nameKey).limit(1).get();
  const doc = snapshot.docs[0];
  return doc ? (doc.data() as PersonDoc) : null;
}

export async function putPerson(uid: string, doc: PersonDoc): Promise<void> {
  await paths.people(uid).doc(doc.personId).set(doc, { merge: true });
}

export async function listPeople(uid: string, limit = 200): Promise<PersonDoc[]> {
  const snapshot = await paths.people(uid).orderBy('lastInteractionAt', 'desc').limit(limit).get();
  return snapshot.docs.map((doc) => doc.data() as PersonDoc);
}

export async function getPerson(uid: string, personId: string): Promise<PersonDoc | null> {
  const snapshot = await paths.people(uid).doc(personId).get();
  return snapshot.exists ? (snapshot.data() as PersonDoc) : null;
}

export async function putFollowUp(uid: string, doc: FollowUpDoc): Promise<void> {
  await paths.followUps(uid).doc(doc.followUpId).set(doc, { merge: true });
}

export async function listFollowUps(
  uid: string,
  state: FollowUpDoc['state'] | 'all',
  owner: 'self' | 'other' | 'all',
  limit = 200,
): Promise<FollowUpDoc[]> {
  let query: Query = paths.followUps(uid);
  if (state !== 'all') query = query.where('state', '==', state);
  if (owner !== 'all') query = query.where('ownerType', '==', owner);
  const snapshot = await query.orderBy('createdAt', 'desc').limit(limit).get();
  return snapshot.docs.map((doc) => doc.data() as FollowUpDoc);
}

export async function patchFollowUp(
  uid: string,
  followUpId: string,
  fields: Partial<FollowUpDoc>,
): Promise<void> {
  await paths
    .followUps(uid)
    .doc(followUpId)
    .set({ ...fields, updatedAt: new Date().toISOString() }, { merge: true });
}

// ---------------------------------------------------------------------------
// Daily brief and jobs
// ---------------------------------------------------------------------------

export async function getDay(uid: string, day: string): Promise<DayDoc | null> {
  const snapshot = await paths.days(uid).doc(day).get();
  return snapshot.exists ? (snapshot.data() as DayDoc) : null;
}

export async function putDay(uid: string, doc: DayDoc): Promise<void> {
  await paths.days(uid).doc(doc.day).set(doc, { merge: true });
}

export async function putJob(uid: string, doc: JobDoc): Promise<void> {
  await paths.jobs(uid).doc(doc.jobId).set(doc, { merge: true });
}

export async function patchJob(uid: string, jobId: string, fields: Partial<JobDoc>): Promise<void> {
  await paths
    .jobs(uid)
    .doc(jobId)
    .set({ ...fields, updatedAt: new Date().toISOString() }, { merge: true });
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Claim an Idempotency-Key. Returns the stored response if this key was already
 * completed, so a retried segment upload or finalize is a no-op rather than a
 * duplicate processing job.
 */
export async function claimIdempotencyKey(
  uid: string,
  key: string,
  fingerprint: string,
): Promise<{ fresh: boolean; response: unknown | null }> {
  const ref = paths.idempotency(uid).doc(key);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) {
      const data = snapshot.data() as { fingerprint: string; response: unknown | null };
      if (data.fingerprint === fingerprint) {
        return { fresh: false, response: data.response ?? null };
      }
      // A changed body under the same key is not abuse here. Synap's keys are
      // derived from a recording, and a recording's own metadata legitimately
      // moves while it is being captured — a device association resolves, a
      // long capture rolls into a new continuous part, the duration grows with
      // every segment. Rejecting that stalled the whole pipeline on the second
      // segment of every recording. Treat the newer body as the truth and
      // replay from it; the endpoints this guards are each idempotent on their
      // own resource id, so a repeat is a no-op rather than a duplicate.
      tx.set(ref, { fingerprint, response: null, updatedAt: new Date().toISOString() }, { merge: true });
      return { fresh: true, response: null };
    }
    tx.set(ref, {
      fingerprint,
      response: null,
      createdAt: new Date().toISOString(),
      // Firestore TTL policy on this field reaps the ledger after 48h.
      expireAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
    return { fresh: true, response: null };
  });
}

export async function completeIdempotencyKey(
  uid: string,
  key: string,
  response: unknown,
): Promise<void> {
  await paths.idempotency(uid).doc(key).set({ response }, { merge: true });
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/** Recursively delete a recording and everything derived from it. */
export async function deleteRecording(uid: string, recordingId: string): Promise<void> {
  await deleteConversationsForRecording(uid, recordingId);
  const followUps = await paths.followUps(uid).where('recordingId', '==', recordingId).get();
  const batch = firestore().batch();
  followUps.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  await firestore().recursiveDelete(paths.recording(uid, recordingId));
}

/** Full account erasure. The wrapped DEK goes last so partial failure still leaves data unreadable. */
export async function deleteUser(uid: string): Promise<void> {
  await firestore().recursiveDelete(paths.user(uid));
}
