import { openJson, openText, sealJson, sealText, type Binding, type Sealed } from '../crypto/envelope.js';
import { extractMemory } from '../gemini/memory.js';
import { formatMs } from '../gemini/transcribe.js';
import * as db from '../store/firestore.js';
import type { RecordingDoc, StructuredMemory } from '../store/types.js';
import { newId } from '../util/ids.js';

export interface MemoryMergeDoc {
  mergeId: string;
  sourceRecordingIds: string[];
  day: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  sealedMemory: Sealed;
  sealedTranscript: Sealed;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryMergeView {
  mergeId: string;
  sourceRecordingIds: string[];
  day: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  memory: StructuredMemory;
  transcript: string;
  createdAt: string;
}

export class MemoryMergeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const mergeCollection = (uid: string) =>
  db.firestore().collection('users').doc(uid).collection('memoryMerges');

function binding(uid: string, mergeId: string, field: string): Binding {
  return { uid, scope: `memoryMerge/${mergeId}`, field };
}

function timestampToMs(value: string): number {
  const parts = value.split(':').map(Number);
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  if (parts.length === 2) return (a * 60 + b) * 1000;
  if (parts.length === 3) return (a * 3600 + b * 60 + c) * 1000;
  return 0;
}

/** Shift the transcript's recording-relative timestamps into the merged timeline. */
export function shiftTranscript(transcript: string, offsetMs: number): string {
  return transcript.replace(/^\[((?:\d{2}:)?\d{2}:\d{2})\]/gm, (_match, stamp: string) => {
    return `[${formatMs(timestampToMs(stamp) + Math.max(0, offsetMs))}]`;
  });
}

/**
 * Merge is deliberately strict: only a contiguous run of the day's ready
 * memories can be merged. Client order is ignored; chronology is canonical.
 */
export function consecutiveSourceIds(availableIds: string[], requestedIds: string[]): string[] {
  const requested = [...new Set(requestedIds)];
  if (requested.length < 2 || requested.length > 5) {
    throw new MemoryMergeError(400, 'invalid_merge_size', 'Choose between 2 and 5 memories to merge.');
  }
  const positions = requested.map((id) => availableIds.indexOf(id));
  if (positions.some((position) => position < 0)) {
    throw new MemoryMergeError(400, 'invalid_merge_source', 'Every selected memory must be ready on the same day.');
  }
  positions.sort((a, b) => a - b);
  const first = positions[0];
  const last = positions[positions.length - 1];
  if (first === undefined || last === undefined || last - first + 1 !== positions.length) {
    throw new MemoryMergeError(400, 'non_consecutive_memories', 'Only consecutive memories can be merged.');
  }
  return positions.map((position) => {
    const id = availableIds[position];
    if (!id) throw new MemoryMergeError(400, 'invalid_merge_source', 'A selected memory is unavailable.');
    return id;
  });
}

function recordingEndMs(recording: RecordingDoc): number {
  const explicit = recording.endedAt ? Date.parse(recording.endedAt) : Number.NaN;
  if (Number.isFinite(explicit)) return explicit;
  return Date.parse(recording.startedAt) + Math.max(0, recording.durationMs || 0);
}

async function knownPeople(uid: string, dek: Buffer): Promise<string[]> {
  const people = await db.listPeople(uid, 100);
  return people
    .filter((person) => person.confirmedByUser)
    .map((person) => {
      try {
        return openJson<{ name: string }>(
          dek,
          person.sealedProfile,
          { uid, scope: `person/${person.personId}`, field: 'profile' },
        ).name;
      } catch {
        return '';
      }
    })
    .filter((name): name is string => Boolean(name));
}

export async function listMemoryMerges(uid: string, dek: Buffer, day?: string): Promise<MemoryMergeView[]> {
  // Intentionally filter/sort this tiny per-user collection in application code.
  // That keeps the feature deployable without a new Firestore composite index.
  const snapshot = await mergeCollection(uid).get();
  return snapshot.docs
    .map((snapshotDoc) => snapshotDoc.data() as MemoryMergeDoc)
    .filter((doc) => !day || doc.day === day)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .map((doc) => ({
      mergeId: doc.mergeId,
      sourceRecordingIds: doc.sourceRecordingIds,
      day: doc.day,
      startedAt: doc.startedAt,
      endedAt: doc.endedAt,
      durationMs: doc.durationMs,
      memory: openJson<StructuredMemory>(dek, doc.sealedMemory, binding(uid, doc.mergeId, 'memory')),
      transcript: openText(dek, doc.sealedTranscript, binding(uid, doc.mergeId, 'transcript')),
      createdAt: doc.createdAt,
    }));
}

export async function createMemoryMerge(
  uid: string,
  dek: Buffer,
  requestedIds: string[],
): Promise<MemoryMergeView> {
  const unique = [...new Set(requestedIds)];
  if (unique.length < 2 || unique.length > 5) {
    throw new MemoryMergeError(400, 'invalid_merge_size', 'Choose between 2 and 5 memories to merge.');
  }

  const sourceDocs = await Promise.all(unique.map((id) => db.getRecording(uid, id)));
  if (sourceDocs.some((recording) => !recording)) {
    throw new MemoryMergeError(404, 'memory_not_found', 'One or more selected memories no longer exist.');
  }
  const recordings = sourceDocs.filter((recording): recording is RecordingDoc => Boolean(recording));
  const firstRecording = recordings[0];
  if (!firstRecording) throw new MemoryMergeError(404, 'memory_not_found', 'No selected memory exists.');
  const mergeDay = firstRecording.day;
  if (recordings.some((recording) => recording.day !== mergeDay)) {
    throw new MemoryMergeError(400, 'different_days', 'Memories must be from the same day.');
  }

  const ready = (await db.listRecordingsByDay(uid, mergeDay)).filter(
    (recording) => recording.state === 'ready' && recording.sealedTranscript && recording.sealedMemory,
  );
  const canonicalIds = consecutiveSourceIds(ready.map((recording) => recording.recordingId), unique);
  const byId = new Map(recordings.map((recording) => [recording.recordingId, recording]));
  const ordered = canonicalIds.map((id) => byId.get(id)).filter((item): item is RecordingDoc => Boolean(item));
  const firstOrdered = ordered[0];
  if (!firstOrdered) throw new MemoryMergeError(409, 'memory_not_ready', 'Selected memories are not ready to merge.');

  const existing = await listMemoryMerges(uid, dek, mergeDay);
  const occupied = new Set(existing.flatMap((merge) => merge.sourceRecordingIds));
  if (canonicalIds.some((id) => occupied.has(id))) {
    throw new MemoryMergeError(409, 'already_merged', 'One of these memories is already part of another merge. Unmerge it first.');
  }

  const firstStartedMs = Date.parse(firstOrdered.startedAt);
  const lastEndedMs = Math.max(...ordered.map(recordingEndMs));
  const durationMs = Math.max(1, lastEndedMs - firstStartedMs);
  const transcripts: string[] = [];
  const highlightOffsetsMs: number[] = [];

  for (const recording of ordered) {
    if (!recording.sealedTranscript) {
      throw new MemoryMergeError(409, 'memory_not_ready', 'Every selected memory needs a complete transcript before it can be merged.');
    }
    const offset = Math.max(0, Date.parse(recording.startedAt) - firstStartedMs);
    const transcript = openText(
      dek,
      recording.sealedTranscript,
      { uid, scope: `recording/${recording.recordingId}`, field: 'transcript' },
    );
    transcripts.push(shiftTranscript(transcript, offset));
    const highlights = await db.listHighlights(uid, recording.recordingId);
    highlightOffsetsMs.push(...highlights.map((highlight) => offset + highlight.offsetMs));
  }

  const transcript = transcripts.filter(Boolean).join('\n\n');
  if (!transcript.trim()) {
    throw new MemoryMergeError(409, 'empty_transcript', 'The selected memories do not contain transcript text.');
  }

  const languages = [...new Set(ordered.map((recording) => recording.language).filter((language): language is string => Boolean(language)))];
  const language = languages.length === 1 ? (languages[0] ?? 'auto') : 'auto';
  const memory = await extractMemory({
    transcript,
    durationMs,
    highlightOffsetsMs,
    knownPeople: await knownPeople(uid, dek),
    language,
  });

  const mergeId = newId();
  const now = new Date().toISOString();
  const doc: MemoryMergeDoc = {
    mergeId,
    sourceRecordingIds: canonicalIds,
    day: mergeDay,
    startedAt: new Date(firstStartedMs).toISOString(),
    endedAt: new Date(lastEndedMs).toISOString(),
    durationMs,
    sealedMemory: sealJson(dek, memory, binding(uid, mergeId, 'memory')),
    sealedTranscript: sealText(dek, transcript, binding(uid, mergeId, 'transcript')),
    createdAt: now,
    updatedAt: now,
  };
  await mergeCollection(uid).doc(mergeId).set(doc);

  return {
    mergeId,
    sourceRecordingIds: canonicalIds,
    day: mergeDay,
    startedAt: doc.startedAt,
    endedAt: doc.endedAt,
    durationMs,
    memory,
    transcript,
    createdAt: now,
  };
}

export async function deleteMemoryMerge(uid: string, mergeId: string): Promise<boolean> {
  const ref = mergeCollection(uid).doc(mergeId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return false;
  await ref.delete();
  return true;
}
