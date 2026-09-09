/**
 * The processing pipeline: audio in, memory out.
 *
 *   uploaded → transcribing → understanding → indexing → ready
 *
 * Each stage is restart-safe and picks up where the last left off. A segment
 * that already has a sealed transcript is never re-transcribed, so a crash
 * halfway through an hour-long capture costs the remaining segments and nothing
 * else. That property is what makes the Cloud Tasks retry policy safe to leave
 * aggressive.
 */

import { config } from '../config.js';
import { keyring } from '../crypto/keyring.js';
import {
  openBytes,
  openJson,
  openText,
  sealJson,
  sealText,
  type Binding,
} from '../crypto/envelope.js';
import { extractMemory } from '../gemini/memory.js';
import { embedContent } from '../gemini/client.js';
import { formatMs, toSpeakerLines, transcribeSegment } from '../gemini/transcribe.js';
import { tagSelfSpeaker } from '../speaker/enrich.js';
import * as db from '../store/firestore.js';
import { readSealedSegment } from '../store/gcs.js';
import type {
  ConversationDoc,
  FollowUpDoc,
  PersonDoc,
  RecordingDoc,
  SegmentDoc,
  StructuredMemory,
  TranscriptWord,
  UserProfile,
} from '../store/types.js';
import { localDay, mergeAliasKeys, nameKey, newId, normalizeName, topicKey } from '../util/ids.js';
import { log } from '../util/log.js';
import { rebuildDay } from './brief.js';

/** Concurrent Gemini transcription calls per recording. */
const TRANSCRIBE_CONCURRENCY = 4;
const SEGMENT_MS = 30_000;

export interface ProcessRecordingOptions {
  /** Reuse sealed segment transcripts only. Missing transcript windows are an error; never call STT. */
  skipTranscription?: boolean;
  /** Refresh the sealed recording memory/day brief without rewriting retrieval/people/follow-up indexes. */
  memoryOnly?: boolean;
}

export function binding(uid: string, scope: string, field: string): Binding {
  return { uid, scope, field };
}

/**
 * Old segment transcripts predate segment-level timestamp prefixes. Preserve the
 * exact text but anchor the whole sealed 30-second window at its recorded start.
 * New transcripts are already grounded and are left untouched. This is what
 * lets a memory-only rebuild recover chronology without paying for STT again.
 */
export function groundSegmentTranscript(text: string, startMs: number): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (/^\[\d{2}:\d{2}(?::\d{2})?\]\s+[^:]+:/u.test(trimmed)) return trimmed;
  return `[${formatMs(startMs)}] S?: ${trimmed}`;
}

export async function processRecording(
  uid: string,
  recordingId: string,
  options: ProcessRecordingOptions = {},
): Promise<void> {
  const user = await db.getUser(uid);
  if (!user) throw new Error(`Unknown user ${uid}`);

  const recording = await db.getRecording(uid, recordingId);
  if (!recording) throw new Error(`Unknown recording ${recordingId}`);
  if (recording.state === 'ready') {
    log.info('Recording already processed', { uid, recordingId });
    return;
  }

  const dek = await keyring.unwrap(uid, user.key);

  try {
    let segments: SegmentDoc[];
    if (options.skipTranscription) {
      segments = await db.listSegments(uid, recordingId);
      if (segments.length === 0) throw new Error('Recording has no segments');
      const missing = segments.filter((segment) => !segment.sealedTranscript);
      if (missing.length > 0) {
        throw new Error(
          `Transcript-only rebuild requires every sealed segment transcript; ${missing.length} window(s) are missing`,
        );
      }
    } else {
      await db.patchRecording(uid, recordingId, { state: 'transcribing', progress: 0.05 });
      segments = await transcribeAll(uid, recordingId, dek, recording);
    }

    await db.patchRecording(uid, recordingId, { state: 'understanding', progress: 0.55 });
    const memory = await understand(uid, recordingId, dek, recording, segments);

    if (options.memoryOnly) {
      // A legacy repair should not duplicate people counters or follow-up docs.
      // Today/Library and the deterministic day brief are sourced from the
      // recording memory itself, so refreshing that sealed source is sufficient.
      await db.patchRecording(uid, recordingId, { progress: 0.9 });
    } else {
      await db.patchRecording(uid, recordingId, { state: 'indexing', progress: 0.8 });
      await index(uid, dek, recording, memory);
    }

    await db.patchRecording(uid, recordingId, {
      state: 'ready',
      progress: 1,
      errorCode: null,
      retryable: false,
    });

    await rebuildDay(uid, recording.day, dek);
    log.info('Recording processed', {
      uid,
      recordingId,
      segments: segments.length,
      conversations: memory.conversations.length,
      transcriptOnly: Boolean(options.skipTranscription),
      memoryOnly: Boolean(options.memoryOnly),
    });
  } catch (cause) {
    const message = (cause as Error).message ?? 'processing failed';
    log.error('Processing failed', { uid, recordingId, error: message });
    await db.patchRecording(uid, recordingId, {
      state: 'failed',
      errorCode: message.slice(0, 200),
      // Cloud Tasks decides whether to retry; this flag tells the PWA whether
      // offering a Retry button is honest.
      retryable: !/unknown|not found|no segments/i.test(message),
    });
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — transcription
// ---------------------------------------------------------------------------

async function transcribeAll(
  uid: string,
  recordingId: string,
  dek: Buffer,
  recording: RecordingDoc,
): Promise<SegmentDoc[]> {
  const segments = await db.listSegments(uid, recordingId);
  if (segments.length === 0) throw new Error('Recording has no segments');

  const pending = segments.filter((segment) => !segment.sealedTranscript && segment.storagePath);
  let done = segments.length - pending.length;

  const queue = [...pending];
  const workers = Array.from({ length: Math.min(TRANSCRIBE_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const segment = queue.shift();
      if (!segment) return;
      await transcribeOne(uid, recordingId, dek, recording, segment);
      done += 1;
      // Transcription is over half the wall-clock time, so its progress is what
      // the PWA's spinner should actually track.
      await db.patchRecording(uid, recordingId, {
        progress: 0.05 + 0.5 * (done / segments.length),
      });
    }
  });

  await Promise.all(workers);
  return db.listSegments(uid, recordingId);
}

async function transcribeOne(
  uid: string,
  recordingId: string,
  dek: Buffer,
  recording: RecordingDoc,
  segment: SegmentDoc,
): Promise<void> {
  const sealed = segment.storagePath ? await readSealedSegment(segment.storagePath) : null;
  if (!sealed) {
    log.warn('Segment audio missing at transcription time', {
      uid,
      recordingId,
      index: segment.index,
    });
    await db.putSegment(uid, recordingId, { ...segment, state: 'failed' });
    return;
  }

  const audio = openBytes(
    dek,
    sealed,
    binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'audio'),
  );

  const result = await transcribeSegment(audio, 'audio/wav', {
    baseOffsetMs: segment.startMs,
    language: recording.language,
  });

  await db.putSegment(uid, recordingId, {
    ...segment,
    state: 'transcribed',
    language: result.speakers.length ? recording.language : recording.language,
    transcribedAt: new Date().toISOString(),
    sealedTranscript: sealText(
      dek,
      result.text,
      binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'transcript'),
    ),
    sealedWords: sealJson(
      dek,
      result.words,
      binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'words'),
    ),
  });
}

// ---------------------------------------------------------------------------
// Stage 2 — understanding
// ---------------------------------------------------------------------------

async function enrichSegmentWords(
  uid: string,
  recordingId: string,
  dek: Buffer,
  segment: SegmentDoc,
  segmentWords: TranscriptWord[],
): Promise<TranscriptWord[]> {
  if (!segment.storagePath || segmentWords.length === 0) return segmentWords;
  try {
    const sealed = await readSealedSegment(segment.storagePath);
    if (!sealed) return segmentWords;
    const audio = openBytes(
      dek,
      sealed,
      binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'audio'),
    );
    return (await tagSelfSpeaker(uid, dek, audio, segmentWords, segment.startMs)).words;
  } catch (cause) {
    // Identity is metadata enrichment, never a prerequisite for a transcript.
    log.warn('Could not enrich one segment with voice profile', {
      uid,
      recordingId,
      index: segment.index,
      error: (cause as Error).message,
    });
    return segmentWords;
  }
}

async function understand(
  uid: string,
  recordingId: string,
  dek: Buffer,
  recording: RecordingDoc,
  segments: SegmentDoc[],
): Promise<StructuredMemory> {
  const words: TranscriptWord[] = [];
  const flat: string[] = [];

  for (const segment of segments) {
    const scope = `recording/${recordingId}/segment/${segment.index}`;
    if (segment.sealedTranscript) {
      const text = openText(dek, segment.sealedTranscript, binding(uid, scope, 'transcript'));
      const grounded = groundSegmentTranscript(text, segment.startMs);
      if (grounded) flat.push(grounded);
    }
    if (segment.sealedWords) {
      const segmentWords = openJson<TranscriptWord[]>(dek, segment.sealedWords, binding(uid, scope, 'words'));
      words.push(...await enrichSegmentWords(uid, recordingId, dek, segment, segmentWords));
    }
  }

  if (flat.length === 0) throw new Error('No transcript was produced for this recording');

  words.sort((a, b) => a.start_ms - b.start_ms);
  const transcript = toSpeakerLines(words, flat.join('\n'));

  const highlights = await db.listHighlights(uid, recordingId);
  const people = await db.listPeople(uid, 100);
  const knownPeople = people
    .filter((person) => person.confirmedByUser)
    .map((person) => {
      try {
        return openJson<{ name: string }>(
          dek,
          person.sealedProfile,
          binding(uid, `person/${person.personId}`, 'profile'),
        ).name;
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  const durationMs = recording.durationMs || segments.length * SEGMENT_MS;

  const memory = await extractMemory({
    transcript,
    durationMs,
    highlightOffsetsMs: highlights.map((highlight) => highlight.offsetMs),
    knownPeople,
    language: recording.language,
  });

  await db.patchRecording(uid, recordingId, {
    sealedMemory: sealJson(dek, memory, binding(uid, `recording/${recordingId}`, 'memory')),
    sealedTranscript: sealText(dek, transcript, binding(uid, `recording/${recordingId}`, 'transcript')),
  });

  return memory;
}

// ---------------------------------------------------------------------------
// Stage 3 — indexing
// ---------------------------------------------------------------------------

async function index(
  uid: string,
  dek: Buffer,
  recording: RecordingDoc,
  memory: StructuredMemory,
): Promise<void> {
  // Reprocessing replaces rather than appends, so a retried recording does not
  // double every conversation in retrieval.
  await db.deleteConversationsForRecording(uid, recording.recordingId);

  const personIds = await upsertPeople(uid, dek, memory, recording);

  for (const conversation of memory.conversations) {
    const conversationId = newId();
    const summaryForEmbedding = [
      conversation.title,
      conversation.summary,
      conversation.topics.join(', '),
      conversation.decisions.map((decision) => decision.text).join(' '),
    ]
      .filter(Boolean)
      .join('\n');

    let embedding: number[] | null = null;
    if (process.env.SYNAP_DISABLE_VECTOR_INDEX !== '1') {
      try {
        embedding = await embedContent(summaryForEmbedding, 'RETRIEVAL_DOCUMENT');
      } catch (cause) {
        // Retrieval degrades to recency + keyword rather than failing the whole
        // recording; the memory itself is already safely stored.
        log.warn('Embedding failed; conversation indexed without a vector', {
          uid,
          recordingId: recording.recordingId,
          error: (cause as Error).message,
        });
      }
    }

    const doc: ConversationDoc = {
      conversationId,
      recordingId: recording.recordingId,
      day: recording.day,
      startMs: conversation.start_ms,
      endMs: conversation.end_ms,
      startedAt: new Date(
        Date.parse(recording.startedAt) + conversation.start_ms,
      ).toISOString(),
      sealedContent: sealJson(
        dek,
        {
          title: conversation.title,
          summary: conversation.summary,
          topics: conversation.topics,
          decisions: conversation.decisions,
          actionItems: conversation.action_items,
          followUps: conversation.follow_ups,
          people: conversation.people.map((person) => person.name),
        },
        binding(uid, `conversation/${conversationId}`, 'content'),
      ),
      embedding,
      personIds: conversation.people
        .map((person) => personIds.get(normalizeName(person.name)))
        .filter((id): id is string => Boolean(id)),
      topicKeys: conversation.topics.map(topicKey).filter(Boolean).slice(0, 20),
      highlightCount: 0,
      createdAt: new Date().toISOString(),
    };

    await db.putConversation(uid, doc);
    await upsertFollowUps(uid, dek, recording, conversation, conversationId, personIds);
  }
}

async function upsertPeople(
  uid: string,
  dek: Buffer,
  memory: StructuredMemory,
  recording: RecordingDoc,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const person of memory.people) {
    const normalized = normalizeName(person.name);
    if (!normalized) continue;

    const key = nameKey(dek, person.name);
    const existing = await db.findPersonByNameKey(uid, key);
    const personId = existing?.personId ?? newId();
    const now = new Date().toISOString();

    // A name the user confirmed outranks whatever the model heard this time.
    // Without this the next recording quietly overwrites the correction, which
    // is the most annoying possible way to lose one.
    let name = person.name;
    if (existing?.confirmedByUser) {
      try {
        name = openJson<{ name: string }>(
          dek,
          existing.sealedProfile,
          binding(uid, `person/${existing.personId}`, 'profile'),
        ).name || person.name;
      } catch {
        name = person.name;
      }
    }

    const doc: PersonDoc = {
      personId,
      // The stored key follows the confirmed name so listings stay consistent,
      // while aliasKeys keeps every spelling the transcript might use matchable.
      nameKey: existing?.confirmedByUser ? (existing.nameKey ?? key) : key,
      aliasKeys: mergeAliasKeys(existing?.aliasKeys, existing?.nameKey, key),
      sealedProfile: sealJson(
        dek,
        {
          name,
          role: person.role,
          evidence: person.evidence,
          confidence: person.confidence,
        },
        binding(uid, `person/${personId}`, 'profile'),
      ),
      // Model-derived identity stays unconfirmed until the user says otherwise.
      confirmedByUser: existing?.confirmedByUser ?? false,
      firstSeenAt: existing?.firstSeenAt ?? recording.startedAt,
      lastInteractionAt: recording.startedAt > (existing?.lastInteractionAt ?? '')
        ? recording.startedAt
        : (existing?.lastInteractionAt ?? now),
      conversationCount: (existing?.conversationCount ?? 0) + 1,
    };

    await db.putPerson(uid, doc);
    ids.set(normalized, personId);
  }

  return ids;
}

async function upsertFollowUps(
  uid: string,
  dek: Buffer,
  recording: RecordingDoc,
  conversation: StructuredMemory['conversations'][number],
  conversationId: string,
  personIds: Map<string, string>,
): Promise<void> {
  const items = [
    ...conversation.action_items.map((action) => ({
      text: action.task,
      owner: action.owner,
      dueDate: action.due_date,
      startMs: action.start_ms,
    })),
    ...conversation.follow_ups.map((followUp) => ({
      text: followUp.text,
      owner: followUp.owner,
      dueDate: null as string | null,
      startMs: followUp.start_ms,
    })),
  ];

  for (const item of items) {
    const ownerIsSelf = item.owner?.trim().toLowerCase() === 'self';
    const followUpId = newId();
    const doc: FollowUpDoc = {
      followUpId,
      sealedTask: sealJson(
        dek,
        { task: item.text, owner: item.owner },
        binding(uid, `followUp/${followUpId}`, 'task'),
      ),
      ownerType: ownerIsSelf ? 'self' : 'other',
      counterpartyPersonId: ownerIsSelf
        ? null
        : (personIds.get(normalizeName(item.owner ?? '')) ?? null),
      dueDate: item.dueDate,
      state: 'open',
      recordingId: recording.recordingId,
      conversationId,
      startMs: item.startMs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.putFollowUp(uid, doc);
  }
}
