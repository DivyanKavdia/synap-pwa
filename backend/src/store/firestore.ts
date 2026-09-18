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
import { requireCompleteSegments } from '../pipeline/recording-segments.js';
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

/** An idempotent create must not write an old snapshot over a live recording. */
export async function createRecording(uid: string, doc: RecordingDoc): Promise<{ doc: RecordingDoc; created: boolean }> {
  const ref = paths.recording(uid, doc.recordingId);
  return firestore().runTransaction(async tx => {
    const current = (await tx.get(ref)).data() as RecordingDoc | undefined;
    if (current?.deleting) throw new SegmentWriteError(404, 'Recording is being deleted');
    if (current) return { doc: current, created: false };
    tx.create(ref, doc);
    return { doc, created: true };
  });
}

export async function patchRecording(
  uid: string,
  recordingId: string,
  fields: Partial<RecordingDoc>,
): Promise<void> {
  await paths
    .recording(uid, recordingId)
    .update({ ...fields, updatedAt: new Date().toISOString() });
}

export const PROCESSING_STALE_MS = 10 * 60_000;
export function isProcessingActive(recording: RecordingDoc, now = Date.now()): boolean {
  return ['transcribing', 'understanding', 'indexing'].includes(recording.state)
    && now - Date.parse(recording.updatedAt) < PROCESSING_STALE_MS;
}

/** A retry must not reset a worker that claimed the recording after the route
 * read it. A changed failure also needs its own cooldown and retry decision. */
export async function resetProcessingForRetry(uid: string, recordingId: string, expectedUpdatedAt: string): Promise<boolean> {
  const ref = paths.recording(uid, recordingId);
  return firestore().runTransaction(async tx => {
    const current = (await tx.get(ref)).data() as RecordingDoc | undefined;
    if (!current || current.deleting) throw new SegmentWriteError(404, 'Unknown recording');
    if (current.updatedAt !== expectedUpdatedAt ||
        !['uploaded', 'failed'].includes(current.state) ||
        (current.state === 'failed' && (!current.retryable || (current.processingFailure?.retryAt ?? 0) > Date.now()))) return false;
    tx.update(ref, { state: 'uploaded', progress: 0, errorCode: null,
      retryable: false, processingFailure: null, processingLease: null, updatedAt: new Date().toISOString() });
    return true;
  });
}

/** Claim and fence one attempt. A timed-out worker can finish its network call,
 * but only the current lease can change the recording or publish its index. */
export async function claimProcessing(uid: string, recordingId: string, lease: string, refreshReady = false): Promise<RecordingDoc> {
  const ref = paths.recording(uid, recordingId);
  return firestore().runTransaction(async tx => {
    const current = (await tx.get(ref)).data() as RecordingDoc | undefined;
    if (!current || current.deleting) throw new Error('Unknown recording');
    if (current.state === 'ready' && !refreshReady) return current;
    if (isProcessingActive(current)) throw new Error('Recording is already processing');
    if (!['uploaded', 'failed', 'ready', 'transcribing', 'understanding', 'indexing'].includes(current.state)) {
      throw new Error(`Recording is not uploaded: ${current.state}`);
    }
    tx.update(ref, { processingLease: lease, state: 'transcribing', processingFailure: null,
      errorCode: null, progress: 0.05, updatedAt: new Date().toISOString() });
    return current;
  });
}

export async function patchProcessing(uid: string, recordingId: string, lease: string, fields: Partial<RecordingDoc>): Promise<void> {
  const ref = paths.recording(uid, recordingId);
  await firestore().runTransaction(async tx => {
    const current = (await tx.get(ref)).data() as RecordingDoc | undefined;
    if (!current || current.deleting) throw new Error('Unknown recording');
    if (current.processingLease !== lease) throw new Error('Processing attempt was superseded');
    tx.update(ref, { ...fields, updatedAt: new Date().toISOString() });
  });
}

export async function listRecordingsByDay(uid: string, day: string): Promise<RecordingDoc[]> {
  const snapshot = await paths.recordings(uid).where('day', '==', day).orderBy('startedAt').get();
  return snapshot.docs.map((doc) => doc.data() as RecordingDoc);
}

export async function saveSpeakerMemory(uid: string, recordingId: string, expectedUpdatedAt: string, fields: Partial<RecordingDoc>): Promise<string | null> {
  const ref = paths.recording(uid, recordingId);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const current = snapshot.data() as RecordingDoc | undefined;
    if (!current || current.state !== 'ready' || current.updatedAt !== expectedUpdatedAt) return null;
    const revision = new Date().toISOString();
    tx.update(ref, { ...fields, updatedAt: revision });
    return revision;
  });
}

/**
 * Most recent recordings across every day.
 *
 * This is what a device that has never seen this account asks for first: it has
 * no local journal, so it cannot know which days to request. Ordering by
 * startedAt alone is a single-field query, which Firestore indexes
 * automatically — deliberately, so restoring history needs no new index.
 */
export async function listRecentRecordings(uid: string, limit: number): Promise<RecordingDoc[]> {
  const snapshot = await paths
    .recordings(uid)
    .orderBy('startedAt', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs.map((doc) => doc.data() as RecordingDoc);
}

export class SegmentWriteError extends Error {
  constructor(readonly status: 404 | 409, message: string, readonly retryable = false) { super(message); }
}

export class TranscriptionBusyError extends SegmentWriteError {
  readonly code = 'transcription_busy';
  constructor(readonly retryAfterMs: number) {
    super(409, 'This audio is already being transcribed. Saved audio is retained.', true);
  }
}

// Longer than the entire 90-second ASR deadline, including preparation/fallback.
export const TRANSCRIPTION_LEASE_MS = 120_000;

/** Claim before any paid work. Transaction retries cannot create another owner. */
export async function claimSegmentTranscription(
  uid: string,
  recordingId: string,
  source: SegmentDoc,
  lease: string,
  now = Date.now(),
  leaseMs = TRANSCRIPTION_LEASE_MS,
): Promise<{ segment: SegmentDoc; claimed: boolean }> {
  const parent = paths.recording(uid, recordingId), ref = paths.segments(uid, recordingId).doc(String(source.index));
  return firestore().runTransaction(async tx => {
    const recording = (await tx.get(parent)).data() as RecordingDoc | undefined;
    const current = (await tx.get(ref)).data() as SegmentDoc | undefined;
    if (!recording || recording.deleting || !current) throw new SegmentWriteError(404, 'Unknown recording or segment');
    if (!sameSegmentSource(current, source) || current.storagePath !== source.storagePath) throw new SegmentWriteError(409, 'Segment source changed');
    if (current.state === 'transcribed' && current.sealedTranscript && current.sealedWords &&
        (current.transcriptionReview?.policy === 'text-first-v1' || JSON.stringify(current.sealedTranscript) !== JSON.stringify(source.sealedTranscript)))
      return { segment: current, claimed: false };
    if (current.transcriptionLease && (current.transcriptionLeaseUntil || 0) > now)
      throw new TranscriptionBusyError(current.transcriptionLeaseUntil! - now);
    const fields = { transcriptionLease: lease, transcriptionLeaseUntil: now + Math.max(1, leaseMs) };
    tx.update(ref, fields);
    return { segment: { ...current, ...fields }, claimed: true };
  });
}

/** A stale worker cannot release the next worker's lease. */
export async function releaseSegmentTranscription(uid: string, recordingId: string, index: number, lease: string): Promise<void> {
  const ref = paths.segments(uid, recordingId).doc(String(index));
  await firestore().runTransaction(async tx => {
    const current = (await tx.get(ref)).data() as SegmentDoc | undefined;
    if (current?.transcriptionLease === lease) tx.update(ref, { transcriptionLease: null, transcriptionLeaseUntil: null });
  });
}

/** Freeze complete upload metadata once; retries never reset processing. */
export async function finalizeRecording(uid: string, recordingId: string, fields: Pick<RecordingDoc, 'endedAt' | 'durationMs' | 'segmentCount'>): Promise<RecordingDoc> {
  const ref = paths.recording(uid, recordingId);
  return firestore().runTransaction(async tx => {
    const current = (await tx.get(ref)).data() as RecordingDoc | undefined;
    if (!current || current.deleting) throw new SegmentWriteError(404, 'Unknown recording');
    if (current.endedAt) {
      if (current.endedAt !== fields.endedAt || current.durationMs !== fields.durationMs || current.segmentCount !== fields.segmentCount) {
        throw new SegmentWriteError(409, 'Finalization conflicts with the saved recording');
      }
      return current;
    }
    if (!['created', 'uploading'].includes(current.state)) throw new SegmentWriteError(409, 'Recording is already finalized');
    const segments = (await tx.get(paths.segments(uid, recordingId))).docs.map(doc => doc.data() as SegmentDoc);
    try { requireCompleteSegments(segments, fields.segmentCount); }
    catch (cause) { throw new SegmentWriteError(409, (cause as Error).message, true); }
    const completed: RecordingDoc = { ...current, ...fields, state: 'uploaded', progress: 0, uploadedSegments: segments.length, updatedAt: new Date().toISOString() };
    tx.update(ref, { ...completed });
    return completed;
  });
}

export function sameSegmentSource(a: SegmentDoc, b: Pick<SegmentDoc, 'index' | 'sha256' | 'bytes' | 'startMs' | 'endMs'>): boolean {
  return a.index === b.index && a.sha256 === b.sha256 && a.bytes === b.bytes &&
    a.startMs === b.startMs && a.endMs === b.endMs;
}

/** Accept one immutable source per index, together with its parent counter. */
export async function acceptSegment(uid: string, recordingId: string, doc: SegmentDoc, createdAt: string): Promise<SegmentDoc> {
  const parent = paths.recording(uid, recordingId), ref = paths.segments(uid, recordingId).doc(String(doc.index));
  return firestore().runTransaction(async tx => {
    const recording = (await tx.get(parent)).data() as RecordingDoc | undefined;
    const current = (await tx.get(ref)).data() as SegmentDoc | undefined;
    if (!recording || recording.deleting) throw new SegmentWriteError(404, 'Unknown recording');
    if (recording.createdAt !== createdAt) throw new SegmentWriteError(409, 'Recording source changed');
    if (current) {
      if (!sameSegmentSource(current, doc)) throw new SegmentWriteError(409, 'Segment source conflicts with the accepted audio');
      return current;
    }
    if (recording.endedAt || !['created', 'uploading'].includes(recording.state)) {
      throw new SegmentWriteError(409, 'Recording is already finalized');
    }
    tx.create(ref, doc);
    tx.update(parent, { state: 'uploading', uploadedSegments: (recording.uploadedSegments || 0) + 1, updatedAt: new Date().toISOString() });
    return doc;
  });
}

/** Commit only to the exact live source. The first complete result wins. */
export async function completeSegmentTranscription(uid: string, recordingId: string, doc: SegmentDoc, supersededEmpty?: SegmentDoc['sealedTranscript'], lease?: string): Promise<SegmentDoc> {
  const parent = paths.recording(uid, recordingId), ref = paths.segments(uid, recordingId).doc(String(doc.index));
  return firestore().runTransaction(async tx => {
    const recording = (await tx.get(parent)).data() as RecordingDoc | undefined;
    const current = (await tx.get(ref)).data() as SegmentDoc | undefined;
    if (!recording || recording.deleting || !current) throw new SegmentWriteError(404, 'Unknown recording or segment');
    if (!sameSegmentSource(current, doc) || current.storagePath !== doc.storagePath) throw new SegmentWriteError(409, 'Segment source changed');
    if (current.state === 'transcribed' && current.sealedTranscript && current.sealedWords &&
        (!supersededEmpty || current.transcriptionReview?.policy === 'text-first-v1' ||
         JSON.stringify(current.sealedTranscript) !== JSON.stringify(supersededEmpty))) return current;
    if (current.transcriptionLease && current.transcriptionLease !== lease)
      throw new SegmentWriteError(409, 'Transcription attempt was superseded', true);
    if (lease && current.transcriptionLease !== lease)
      throw new SegmentWriteError(409, 'Transcription attempt was superseded', true);
    const fields = { state: doc.state, language: doc.language, transcribedAt: doc.transcribedAt,
      transcriptionReview: doc.transcriptionReview, transcriptionAudioPolicy: doc.transcriptionAudioPolicy || 'stored-upload-v1',
      ...(doc.transcriptionAudioUsage ? { transcriptionAudioUsage: doc.transcriptionAudioUsage } : {}),
      sealedTranscript: doc.sealedTranscript, sealedWords: doc.sealedWords,
      ...(lease ? { transcriptionLease: null, transcriptionLeaseUntil: null } : {}) };
    tx.update(ref, fields);
    return { ...current, ...fields };
  });
}

export async function saveSegmentSpeakerMap(uid: string, recordingId: string, source: SegmentDoc, lease: string, sealedSpeakerMap: SegmentDoc['sealedSpeakerMap']): Promise<void> {
  const parent = paths.recording(uid, recordingId), ref = paths.segments(uid, recordingId).doc(String(source.index));
  await firestore().runTransaction(async tx => {
    const recording = (await tx.get(parent)).data() as RecordingDoc | undefined;
    const current = (await tx.get(ref)).data() as SegmentDoc | undefined;
    if (!recording || recording.deleting || !current) throw new SegmentWriteError(404, 'Unknown recording or segment');
    if (recording.processingLease !== lease) throw new SegmentWriteError(409, 'Processing attempt was superseded');
    if (!sameSegmentSource(current, source) || current.storagePath !== source.storagePath) throw new SegmentWriteError(409, 'Segment source changed');
    tx.update(ref, { sealedSpeakerMap });
  });
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
  // Match the selective date-range index before recency. Ordering only by
  // startedAt required an undeclared index and could scan the entire history.
  if (scope.from || scope.to) query = query.orderBy('day', 'desc');
  const snapshot = await query.orderBy('startedAt', 'desc').limit(limit).get();
  return snapshot.docs.map((doc) => normalizeConversation(doc.data()));
}

export async function conversationsForPerson(uid:string,personId:string):Promise<ConversationDoc[]> {
  try {
    const snapshot=await paths.conversations(uid).where('personIds','array-contains',personId).orderBy('startedAt','desc').limit(12).get();
    return snapshot.docs.map(doc=>normalizeConversation(doc.data()));
  }catch(error){
    if((error as {code?:number}).code!==9)throw error;
    // A deployment without the optional person/recency index can still prepare
    // from recent history without delaying the UI or changing infrastructure.
    return (await recentConversations(uid,300)).filter(c=>c.personIds.includes(personId)).slice(0,12);
  }
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

/**
 * Find a person by any name they have been known under.
 *
 * The alias query is tried first so a renamed person still matches the name the
 * transcript used. The exact-nameKey query remains as a fallback for documents
 * written before aliasKeys existed; both are single-field queries Firestore
 * indexes automatically, so neither needs a composite index.
 */
export async function findPersonByNameKey(uid: string, nameKey: string): Promise<PersonDoc | null> {
  const byAlias = await paths
    .people(uid)
    .where('aliasKeys', 'array-contains', nameKey)
    .limit(1)
    .get();
  const alias = byAlias.docs[0];
  if (alias) return alias.data() as PersonDoc;

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

export async function deletePerson(uid: string, personId: string): Promise<void> {
  await paths.people(uid).doc(personId).delete();
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

/** Updates an existing task; a stale completion button must not create a phantom task. */
export async function patchFollowUp(
  uid: string,
  followUpId: string,
  fields: Partial<FollowUpDoc>,
): Promise<boolean> {
  try {
    await paths
      .followUps(uid)
      .doc(followUpId)
      .update({ ...fields, updatedAt: new Date().toISOString() });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 5) return false;
    throw error;
  }
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

export async function beginRecordingDeletion(uid: string, recordingId: string): Promise<void> {
  // Fence publishers before removing derived rows. Repeated deletion can resume
  // cleanup, but no in-flight worker can recreate the index while it is erased.
  try { await paths.recording(uid, recordingId).update({ deleting: true, processingLease: null }); }
  catch (cause) { if ((cause as { code?: number }).code !== 5) throw cause; }
}

/** Recursively delete a recording and everything derived from it. */
export async function deleteRecording(uid: string, recordingId: string): Promise<void> {
  await beginRecordingDeletion(uid, recordingId);
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
