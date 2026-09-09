/**
 * Ask Synap — grounded retrieval over personal memory.
 *
 * The single hard rule: an answer about a person's own life must come from that
 * person's own recordings, or it must not come at all. A model that answers
 * "what did Ankit say about the launch?" from general world knowledge is worse
 * than useless — it is confidently fabricating someone's memory back at them.
 *
 * So the answering model never sees the question without evidence attached, is
 * given no tools, and can only cite by index into the evidence array it was
 * handed. An answer whose citations do not resolve is downgraded to "not found"
 * rather than shown.
 */

import { config } from '../config.js';
import { createInteraction, interactionJson } from './client.js';
import { ANSWER_SCHEMA, QUERY_SCHEMA, jsonResponseFormat } from './schemas.js';

const ANSWER_INSTRUCTIONS = `You answer questions about one person's own recorded conversations, using only the numbered evidence supplied.

Rules:
1. Use only the evidence. You have no other knowledge of this person's life. General world knowledge must never be used to answer a question about what someone said or did.
2. Cite by index. source_indices must contain the indices of the evidence items that actually support your answer.
3. If the evidence does not answer the question, say so plainly, set confidence to "none" and return an empty source_indices. Do not guess, and do not offer a partial answer dressed up as a full one.
4. Quote sparingly and exactly. A quote must appear verbatim in the evidence.
5. Answer in the language the question was asked in.
6. Be direct. No preamble, no restating the question.`;

const QUERY_INSTRUCTIONS = `Extract retrieval filters from a question about someone's recorded conversations. Today's date is supplied. Resolve relative dates ("last week", "yesterday") into absolute YYYY-MM-DD bounds. Return empty arrays and nulls when a filter is not implied — do not invent constraints.`;

export interface ParsedQuery {
  people: string[];
  topics: string[];
  from: string | null;
  to: string | null;
  intent: 'recall' | 'commitments' | 'people' | 'decisions' | 'summary' | 'other';
}

export async function parseQuery(
  query: string,
  today: string,
  signal?: AbortSignal,
): Promise<ParsedQuery> {
  try {
    const response = await createInteraction(
      {
        model: config.gemini.queryModel,
        input: `Today is ${today}.\n\nQuestion: ${query}`,
        system_instruction: QUERY_INSTRUCTIONS,
        response_format: jsonResponseFormat(QUERY_SCHEMA),
        generation_config: { thinking_level: 'minimal' },
      },
      signal,
    );
    const parsed = interactionJson<ParsedQuery>(response);
    return {
      people: parsed.people ?? [],
      topics: parsed.topics ?? [],
      from: parsed.from ?? null,
      to: parsed.to ?? null,
      intent: parsed.intent ?? 'recall',
    };
  } catch {
    // Query parsing is an optimisation, not a requirement. A failure here
    // degrades to unfiltered semantic search rather than failing the request.
    return { people: [], topics: [], from: null, to: null, intent: 'recall' };
  }
}

export interface Evidence {
  recordingId: string;
  conversationId: string;
  startMs: number;
  endMs: number;
  day: string;
  title: string;
  summary: string;
}

export interface GroundedAnswer {
  answer: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
  sources: {
    recording_id: string;
    conversation_id: string;
    start_ms: number;
    end_ms: number;
    quote: string | null;
  }[];
}

const NOT_FOUND: GroundedAnswer = {
  answer:
    "I don't have anything in your recordings that answers that. It may not have been captured, or it may be in a recording that hasn't finished processing.",
  confidence: 'none',
  sources: [],
};

export async function answerFromEvidence(
  query: string,
  evidence: Evidence[],
  signal?: AbortSignal,
): Promise<GroundedAnswer> {
  if (evidence.length === 0) return NOT_FOUND;

  const numbered = evidence
    .map((item, index) =>
      [
        `[${index}] ${item.day} · ${item.title}`,
        `time range: ${item.startMs}–${item.endMs} ms`,
        item.summary,
      ].join('\n'),
    )
    .join('\n\n');

  const response = await createInteraction(
    {
      model: config.gemini.askModel,
      input: `Evidence:\n\n${numbered}\n\nQuestion: ${query}`,
      system_instruction: ANSWER_INSTRUCTIONS,
      response_format: jsonResponseFormat(ANSWER_SCHEMA),
      generation_config: { thinking_level: 'low' },
    },
    signal,
  );

  return resolveAnswer(interactionJson<RawAnswer>(response), evidence);
}

export interface RawAnswer {
  answer: string;
  confidence: GroundedAnswer['confidence'];
  source_indices: number[];
  quotes: string[];
}

/**
 * Turn the model's raw citation indices into real sources, or refuse.
 *
 * Kept separate from the network call because this is the guard that decides
 * whether an answer is trustworthy, and a guard that cannot be tested directly
 * is not a guard.
 */
export function resolveAnswer(raw: RawAnswer, evidence: Evidence[]): GroundedAnswer {
  const claimed = raw.source_indices ?? [];
  const indices = claimed.filter(
    (index) => Number.isInteger(index) && index >= 0 && index < evidence.length,
  );

  // An index outside the evidence array means the model invented a source.
  // That discredits the whole answer, not just the one citation — if it will
  // fabricate a reference it will fabricate the claim resting on it.
  if (indices.length !== claimed.length) return NOT_FOUND;
  if (indices.length === 0 || raw.confidence === 'none') return NOT_FOUND;
  if (!raw.answer?.trim()) return NOT_FOUND;

  const sources = indices.slice(0, config.limits.maxAskSources).map((index, position) => {
    const item = evidence[index]!;
    const quote = raw.quotes?.[position];
    return {
      recording_id: item.recordingId,
      conversation_id: item.conversationId,
      start_ms: item.startMs,
      end_ms: item.endMs,
      // Only keep a quote that appears verbatim in the evidence we supplied.
      quote: quote && item.summary.includes(quote) ? quote : null,
    };
  });

  return { answer: raw.answer.trim(), confidence: raw.confidence, sources };
}

export const NOT_FOUND_ANSWER = NOT_FOUND;
