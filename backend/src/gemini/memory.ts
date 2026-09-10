/**
 * Structured memory extraction and the daily brief.
 *
 * The prompts here are the product. Everything else in this repo moves bytes
 * around; this is where a day of ambient audio becomes something worth keeping.
 * Three rules are stated to the model explicitly and enforced again in code
 * afterwards, because a prompt is a request and a validator is a guarantee:
 *
 *  1. No invented people, owners, dates, decisions or facts.
 *  2. A proposal is not a decision. "We could ship Friday" and "we're shipping
 *     Friday" are different objects, and conflating them is how a second brain
 *     starts lying to its owner.
 *  3. Conversation boundaries come from evidence — a real gap, a participant
 *     change, a context switch — never from where the upload happened to be
 *     chunked. False merge beats inventing meetings that never happened.
 */

import { config } from '../config.js';
import { clamp } from '../util/retry.js';
import type { DailyBrief, StructuredMemory } from '../store/types.js';
import { createInteraction, interactionJson } from './client.js';
import { BRIEF_SCHEMA, MEMORY_SCHEMA, jsonResponseFormat } from './schemas.js';
import { formatMs } from './transcribe.js';

const MEMORY_INSTRUCTIONS = `You build a reliable personal memory from a chronological transcript of one continuous capture.

Evidence rules, in order of priority:
1. Never invent a person, owner, due date, decision, number or fact. If the words do not support it, leave it out or use null.
2. Distinguish a proposal from a confirmed decision. Only record a decision when the speakers settle it. A later explicit decision supersedes an earlier proposal on the same subject.
3. Record a commitment only when someone actually commits. "I'll send it" is a commitment; "someone should send it" is not.
4. Every conversation, decision, action item and follow-up must carry start_ms and end_ms grounded in the supplied timestamps. Never collapse distinct conversations to 0 merely because exact word timing is unavailable; use the nearest supplied segment timestamp.
5. Identify people only from evidence in the words — self-introduction, direct address, or a clear role statement. Speaker labels like S1 are not names. Use role "self" for the wearer when the audio makes that clear. Do not merge two people because a first name matches.
6. For each conversation, separate attendance from subject matter. participants contains only named people evidenced as actually speaking or directly participating in that conversation. mentioned_people contains named people who are discussed or referenced but are not evidenced as participants. A person's name appearing in the transcript is not proof they were on the call.
7. The conversation summary must say what was actually discussed. Do not use a list of names as a substitute for the summary, and do not imply that a mentioned person spoke unless evidence supports it.
8. Segment the timeline into distinct real-world conversations only where there is evidence of a true boundary: a sustained gap, a participant change, an explicit opening or closing, or a hard context switch. Adjacent blocks about the same subject stay in one conversation. A false merge is much better than inventing a meeting.
9. Windows marked HIGHLIGHT were flagged by the wearer in the moment. Weight them as important, but they are still bound by the evidence rules above.
10. Language may be English, Hindi or mixed Hinglish. Write summaries in the dominant language of the conversation, preserving names and technical terms as spoken.

Return only the requested schema.`;

const BRIEF_INSTRUCTIONS = `You write one person's daily brief from structured memories already extracted from their day.

Rules:
1. Work only from the supplied memories. Never add anything that is not in them, and never re-interpret a decision.
2. Every decision, commitment, waiting-on item and highlight must carry the recording_id and start_ms it came from, copied exactly from the input.
3. Separate what the person committed to from what they are waiting on from someone else.
4. The narrative is a few plain sentences about what actually happened. No preamble, no motivational framing, no "you had a productive day".
5. If the day contains nothing in a category, return an empty array. Do not pad.

Return only the requested schema.`;

export interface MemoryContext {
  /** Speaker-attributed transcript lines with timestamps. */
  transcript: string;
  durationMs: number;
  /** Offsets the wearer marked with the pendant's Remember gesture. */
  highlightOffsetsMs: number[];
  /** Names the user has already confirmed, supplied as disambiguation context. */
  knownPeople: string[];
  language: string;
}

export async function extractMemory(
  context: MemoryContext,
  signal?: AbortSignal,
): Promise<StructuredMemory> {
  const highlights = context.highlightOffsetsMs
    .map((offset) => `- HIGHLIGHT at ${formatMs(offset)} (${offset} ms)`)
    .join('\n');

  const known = context.knownPeople.length
    ? `People this user has already confirmed elsewhere. Use these spellings when the audio clearly refers to the same person; never assume a match on a first name alone:\n${context.knownPeople
        .map((name) => `- ${name}`)
        .join('\n')}`
    : 'No previously confirmed people.';

  const input = [
    `Capture duration: ${context.durationMs} ms.`,
    `Detected language: ${context.language}.`,
    known,
    highlights ? `Wearer highlights:\n${highlights}` : 'No wearer highlights.',
    '',
    'Transcript:',
    context.transcript,
  ].join('\n');

  const response = await createInteraction(
    {
      model: config.gemini.memoryModel,
      input,
      system_instruction: MEMORY_INSTRUCTIONS,
      response_format: jsonResponseFormat(MEMORY_SCHEMA),
      // Conversation segmentation, decisions and commitments are product-facing
      // semantics. The cost-saving minimal setting caused visible quality loss.
      generation_config: { thinking_level: 'medium' },
      usage_label: 'memory_extract',
    },
    signal,
  );

  return validateMemory(interactionJson<StructuredMemory>(response), context.durationMs);
}

/**
 * Post-validation. The schema guarantees shape, not honesty: it cannot stop a
 * model from emitting an action item timed at 9 hours into a 40 minute capture,
 * or a person with empty evidence. Anything that fails here is dropped rather
 * than corrected, because a quietly repaired fact is worse than a missing one.
 */
export function validateMemory(memory: StructuredMemory, durationMs: number): StructuredMemory {
  const inRange = (start: number, end: number) =>
    Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= durationMs && end >= start;

  const people = (memory.people ?? []).filter(
    (person) => person.name?.trim() && person.evidence?.trim(),
  );
  const knownNames = new Set(people.map((person) => person.name.trim().toLowerCase()));
  const cleanNames = (values: unknown, allowSelf = false) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(values) ? values : []) {
      const name = String(raw ?? '').trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      if (!(knownNames.has(key) || (allowSelf && key === 'self'))) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  };

  const conversations = (memory.conversations ?? [])
    .filter((conversation) => inRange(conversation.start_ms, conversation.end_ms))
    .map((conversation) => {
      const extended = conversation as typeof conversation & {
        participants?: string[];
        mentioned_people?: string[];
      };
      const participants = cleanNames(extended.participants, true);
      const participantKeys = new Set(participants.map((name) => name.toLowerCase()));
      const mentionedPeople = cleanNames(extended.mentioned_people)
        .filter((name) => !participantKeys.has(name.toLowerCase()));
      return {
        ...conversation,
        start_ms: clamp(conversation.start_ms, 0, durationMs),
        end_ms: clamp(conversation.end_ms, 0, durationMs),
        people: (conversation.people ?? []).filter((person) => person.name?.trim()),
        participants,
        mentioned_people: mentionedPeople,
        decisions: (conversation.decisions ?? []).filter(
          (decision) => decision.text?.trim() && inRange(decision.start_ms, decision.end_ms),
        ),
        action_items: (conversation.action_items ?? []).filter(
          (action) =>
            action.task?.trim() &&
            inRange(action.start_ms, action.end_ms) &&
            (action.owner?.toLowerCase() === 'self' ||
              knownNames.has(action.owner?.trim().toLowerCase() ?? '')) &&
            isValidDate(action.due_date),
        ),
        follow_ups: (conversation.follow_ups ?? []).filter(
          (followUp) => followUp.text?.trim() && inRange(followUp.start_ms, followUp.end_ms),
        ),
      };
    })
    .sort((a, b) => a.start_ms - b.start_ms);

  return {
    schema_version: 2,
    title: memory.title?.trim() || 'Untitled capture',
    executive_summary: memory.executive_summary?.trim() ?? '',
    key_points: (memory.key_points ?? []).filter((point) => point?.trim()),
    people,
    topics: [...new Set((memory.topics ?? []).map((topic) => topic?.trim()).filter(Boolean))] as string[],
    conversations,
  };
}

function isValidDate(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export interface BriefInput {
  day: string;
  memories: { recording_id: string; started_at: string; memory: StructuredMemory }[];
}

/**
 * Retained as an optional presentation helper for future/user-triggered prose.
 * The production day rebuild is deterministic (pipeline/brief.ts), so this is
 * no longer paid once for every recording completion.
 */
export async function generateBrief(input: BriefInput, signal?: AbortSignal): Promise<DailyBrief> {
  const response = await createInteraction(
    {
      model: config.gemini.memoryModel,
      input: JSON.stringify(input),
      system_instruction: BRIEF_INSTRUCTIONS,
      response_format: jsonResponseFormat(BRIEF_SCHEMA),
      generation_config: { thinking_level: 'medium' },
      usage_label: 'daily_brief_manual',
    },
    signal,
  );

  const brief = interactionJson<DailyBrief>(response);
  const validIds = new Set(input.memories.map((entry) => entry.recording_id));
  const grounded = <T extends { recording_id: string }>(items: T[] | undefined) =>
    (items ?? []).filter((item) => validIds.has(item.recording_id));

  return {
    narrative: brief.narrative?.trim() ?? '',
    decisions: grounded(brief.decisions),
    commitments: grounded(brief.commitments),
    waiting_on: grounded(brief.waiting_on),
    unresolved: (brief.unresolved ?? []).filter((item) => item?.trim()),
    highlights: grounded(brief.highlights),
    people: brief.people ?? [],
    topics: brief.topics ?? [],
  };
}
