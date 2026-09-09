/**
 * Daily brief assembly.
 *
 * The brief is derived from structured memory, never from re-reading audio or
 * re-transcribing anything. Rebuilds are deliberately deterministic: every
 * recording already paid once for structured memory extraction, so rebuilding
 * the same day after each new recording must not resend the whole day to an LLM.
 */

import { keyring } from '../crypto/keyring.js';
import { openJson, sealJson } from '../crypto/envelope.js';
import * as db from '../store/firestore.js';
import type { DailyBrief, StructuredMemory } from '../store/types.js';
import { binding } from './process.js';

const EMPTY_BRIEF: DailyBrief = {
  narrative: '',
  decisions: [],
  commitments: [],
  waiting_on: [],
  unresolved: [],
  highlights: [],
  people: [],
  topics: [],
};

/**
 * Rebuild one day's brief from every ready recording in it.
 * `dek` is passed in when the caller already holds it, to avoid a second
 * unwrap on the hot path after processing.
 *
 * Important cost invariant: this function performs no model call. A day may be
 * rebuilt dozens of times as recordings finish or names are corrected; paying
 * to summarize all prior memories on every rebuild creates quadratic token
 * growth. The executive summaries already stored in each StructuredMemory are
 * the model-generated prose, while decisions/actions/people/topics can be
 * assembled exactly and cheaply here.
 */
export async function rebuildDay(uid: string, day: string, dek?: Buffer): Promise<DailyBrief> {
  const user = await db.getUser(uid);
  if (!user) throw new Error(`Unknown user ${uid}`);
  const key = dek ?? (await keyring.unwrap(uid, user.key));

  const recordings = await db.listRecordingsByDay(uid, day);
  const ready = recordings.filter(
    (recording) => recording.state === 'ready' && recording.sealedMemory,
  );

  if (ready.length === 0) {
    const empty: DailyBrief = { ...EMPTY_BRIEF };
    await db.putDay(uid, {
      day,
      sealedBrief: sealJson(key, empty, binding(uid, `day/${day}`, 'brief')),
      recordingIds: [],
      generatedAt: new Date().toISOString(),
    });
    return empty;
  }

  const memories = ready.map((recording) => ({
    recording_id: recording.recordingId,
    started_at: recording.startedAt,
    memory: openJson<StructuredMemory>(
      key,
      recording.sealedMemory!,
      binding(uid, `recording/${recording.recordingId}`, 'memory'),
    ),
  }));

  const brief = fallbackBrief(memories);

  await db.putDay(uid, {
    day,
    sealedBrief: sealJson(key, brief, binding(uid, `day/${day}`, 'brief')),
    recordingIds: ready.map((recording) => recording.recordingId),
    generatedAt: new Date().toISOString(),
  });

  return brief;
}

export async function readDay(uid: string, day: string, dek: Buffer): Promise<DailyBrief | null> {
  const doc = await db.getDay(uid, day);
  if (!doc) return null;
  return openJson<DailyBrief>(dek, doc.sealedBrief, binding(uid, `day/${day}`, 'brief'));
}

/**
 * Deterministic assembly used as the production day brief. It preserves exact
 * provenance and does not reinterpret decisions, commitments or people.
 */
export function fallbackBrief(
  memories: { recording_id: string; memory: StructuredMemory }[],
): DailyBrief {
  const brief: DailyBrief = {
    ...EMPTY_BRIEF,
    decisions: [],
    commitments: [],
    waiting_on: [],
    highlights: [],
  };
  const people = new Set<string>();
  const topics = new Set<string>();

  for (const { recording_id, memory } of memories) {
    memory.people.forEach((person) => people.add(person.name));
    memory.topics.forEach((topic) => topics.add(topic));

    for (const conversation of memory.conversations) {
      for (const decision of conversation.decisions) {
        brief.decisions.push({ text: decision.text, recording_id, start_ms: decision.start_ms });
      }
      for (const action of conversation.action_items) {
        const entry = {
          text: action.task,
          due_date: action.due_date,
          recording_id,
          start_ms: action.start_ms,
        };
        if (action.owner?.toLowerCase() === 'self') brief.commitments.push(entry);
        else
          brief.waiting_on.push({
            text: action.task,
            person: action.owner,
            recording_id,
            start_ms: action.start_ms,
          });
      }
    }
  }

  brief.people = [...people];
  brief.topics = [...topics];
  brief.narrative = memories
    .map(({ memory }) => memory.executive_summary)
    .filter(Boolean)
    .join(' ');

  return brief;
}
