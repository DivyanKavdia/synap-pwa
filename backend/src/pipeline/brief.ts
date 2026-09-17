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
import type { DailyBrief, StructuredMemory, FollowUpContent, FollowUpDoc } from '../store/types.js';
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
  await currentActions(uid, key, brief, ready.map(recording => recording.recordingId));

  await db.putDay(uid, {
    day,
    sealedBrief: sealJson(key, brief, binding(uid, `day/${day}`, 'brief')),
    recordingIds: ready.map((recording) => recording.recordingId),
    generatedAt: new Date().toISOString(),
  });

  return brief;
}

async function currentActions(uid: string, key: Buffer, brief: DailyBrief, recordingIds: string[]): Promise<DailyBrief> {
  brief.questions = (brief.questions || []).filter(item => !item.action_id);
  const tasks: FollowUpDoc[] = [];
  for (const recordingId of recordingIds) {
    const snapshot = await db.paths.followUps(uid).where('recordingId', '==', recordingId).get();
    tasks.push(...snapshot.docs.map(doc => doc.data() as FollowUpDoc));
  }
  brief.commitments = []; brief.waiting_on = [];
  for (const task of tasks.filter(item => item.state === 'open')) {
    const content = openJson<FollowUpContent>(key, task.sealedTask, binding(uid, `followUp/${task.followUpId}`, 'task'));
    const source = { recording_id: task.recordingId, start_ms: task.startMs };
    if (task.sourceMissing || !content.owner) {
      brief.questions!.push({ text: content.task, action_id: task.followUpId, ...source });
    } else if (task.ownerType === 'self') brief.commitments.push({ text: content.task, due_date: task.dueDate, ...source });
    else brief.waiting_on.push({ text: content.task, person: content.owner, ...source });
  }

  const seen = new Set<string>();
  brief.questions = brief.questions.filter(item => {
    const identity = JSON.stringify([item.recording_id,item.start_ms,item.text]);
    if(seen.has(identity)) return false; seen.add(identity); return true;
  });
  return brief;
}

export async function readDay(uid: string, day: string, dek: Buffer): Promise<DailyBrief | null> {
  const doc = await db.getDay(uid, day);
  if (!doc) return null;
  const brief = openJson<DailyBrief>(dek, doc.sealedBrief, binding(uid, `day/${day}`, 'brief'));
  return currentActions(uid, dek, brief, doc.recordingIds); // A stale rebuild cannot revive completed work.
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
    unresolved: [],
    outcomes: [], risks: [], questions: [],
  };
  const people = new Set<string>();
  const topics = new Set<string>();

  for (const { recording_id, memory } of memories) {
    memory.people.forEach((person) => people.add(person.name));
    memory.topics.forEach((topic) => topics.add(topic));

    for (const conversation of memory.conversations) {
      for (const question of conversation.unresolved_questions || []) {
        if (!brief.unresolved.includes(question.text)) brief.unresolved.push(question.text);
        brief.questions!.push({ text: question.text, recording_id, start_ms: question.start_ms });
      }
      for (const outcome of conversation.outcomes || []) brief.outcomes!.push({ text: outcome.text, recording_id, start_ms: outcome.start_ms });
      for (const risk of conversation.risks || []) brief.risks!.push({ text: risk.text, recording_id, start_ms: risk.start_ms });
      for (const decision of conversation.decisions) {
        brief.decisions.push({ text: decision.text, recording_id, start_ms: decision.start_ms });
      }
      for (const action of [...conversation.action_items, ...conversation.follow_ups.map(item => ({ ...item, task: item.text, due_date: item.due_date || null }))]) {
        const entry = {
          text: action.task,
          due_date: action.due_date,
          recording_id,
          start_ms: action.start_ms,
        };
        if (action.owner?.toLowerCase() === 'self') brief.commitments.push(entry);
        else if (action.owner)
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
