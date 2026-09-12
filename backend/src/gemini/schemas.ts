/**
 * Structured-output schemas.
 *
 * These are the contract that keeps a language model from inventing a person's
 * life. Two conventions run through all of them:
 *
 *  - Every factual object carries `start_ms`/`end_ms` pointing back at the
 *    transcript window it came from. An item with no provenance is a
 *    hallucination by definition, and the pipeline drops it.
 *  - Unknown values are explicit nulls, never invented defaults. A due date the
 *    speaker never gave is `null`, not "next Friday".
 *
 * Gemini rejects very large or deeply nested schemas, so these stay shallow and
 * reuse fragments rather than nesting conversations inside conversations.
 */

export const SOURCE_FIELDS = {
  start_ms: { type: 'integer', description: 'Start of the supporting transcript window' },
  end_ms: { type: 'integer', description: 'End of the supporting transcript window' },
} as const;

const PERSON = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Name exactly as spoken. Never invent one.' },
    role: {
      type: 'string',
      enum: ['self', 'participant', 'colleague', 'customer', 'family', 'friend', 'unknown'],
    },
    evidence: { type: 'string', description: 'The words that established this identity' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['name', 'role', 'evidence', 'confidence'],
} as const;

const ACTION = {
  type: 'object',
  properties: {
    task: { type: 'string' },
    kind: { type: 'string', enum: ['commitment', 'reminder'], description: 'reminder only for an explicit spoken request to remember or be reminded to do something' },
    evidence: { type: 'string', description: 'Exact short supporting quote from the transcript' },
    owner: { type: 'string', description: 'A name from the people list, or "self"' },
    due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if never stated' },
    ...SOURCE_FIELDS,
  },
  required: ['task', 'kind', 'evidence', 'owner', 'due_date', 'start_ms', 'end_ms'],
} as const;

const STATEMENT = {
  type: 'object',
  properties: { text: { type: 'string' }, ...SOURCE_FIELDS },
  required: ['text', 'start_ms', 'end_ms'],
} as const;

const FOLLOW_UP = {
  type: 'object',
  properties: { text: { type: 'string' }, owner: { type: 'string' }, ...SOURCE_FIELDS },
  required: ['text', 'owner', 'start_ms', 'end_ms'],
} as const;

const CONVERSATION = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    ...SOURCE_FIELDS,
    people: { type: 'array', items: PERSON },
    participants: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named people evidenced as actually speaking or directly participating in this conversation. Do not include people merely discussed.',
    },
    mentioned_people: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named people referenced or discussed but not evidenced as participants in this conversation.',
    },
    topics: { type: 'array', items: { type: 'string' } },
    chapters: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, ...SOURCE_FIELDS }, required: ['title', 'summary', 'start_ms', 'end_ms'] }, description: 'Non-overlapping topic chapters inside this conversation. Use real topic changes, not upload boundaries; at most 12.' },
    unresolved_questions: { type: 'array', items: STATEMENT },
    decisions: { type: 'array', items: STATEMENT },
    action_items: { type: 'array', items: ACTION },
    follow_ups: { type: 'array', items: FOLLOW_UP },
  },
  required: [
    'title',
    'summary',
    'start_ms',
    'end_ms',
    'people',
    'participants',
    'mentioned_people',
    'topics',
    'chapters',
    'unresolved_questions',
    'decisions',
    'action_items',
    'follow_ups',
  ],
} as const;

export const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    schema_version: { type: 'integer' },
    title: { type: 'string' },
    executive_summary: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
    people: { type: 'array', items: PERSON },
    topics: { type: 'array', items: { type: 'string' } },
    conversations: { type: 'array', items: CONVERSATION },
  },
  required: [
    'schema_version',
    'title',
    'executive_summary',
    'key_points',
    'people',
    'topics',
    'conversations',
  ],
} as const;

export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    narrative: { type: 'string', description: 'A few sentences. What actually happened today.' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          recording_id: { type: 'string' },
          start_ms: { type: 'integer' },
        },
        required: ['text', 'recording_id', 'start_ms'],
      },
    },
    commitments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          due_date: { type: ['string', 'null'] },
          recording_id: { type: 'string' },
          start_ms: { type: 'integer' },
        },
        required: ['text', 'due_date', 'recording_id', 'start_ms'],
      },
    },
    waiting_on: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          person: { type: 'string' },
          recording_id: { type: 'string' },
          start_ms: { type: 'integer' },
        },
        required: ['text', 'person', 'recording_id', 'start_ms'],
      },
    },
    unresolved: { type: 'array', items: { type: 'string' } },
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          recording_id: { type: 'string' },
          start_ms: { type: 'integer' },
        },
        required: ['text', 'recording_id', 'start_ms'],
      },
    },
    people: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'narrative',
    'decisions',
    'commitments',
    'waiting_on',
    'unresolved',
    'highlights',
    'people',
    'topics',
  ],
} as const;

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    /** Indices into the evidence array the caller supplied, not free-form IDs. */
    source_indices: { type: 'array', items: { type: 'integer' } },
    quotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'confidence', 'source_indices', 'quotes'],
} as const;

/** Cheap structured parse of a natural-language question into retrieval filters. */
export const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    people: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
    from: { type: ['string', 'null'], description: 'YYYY-MM-DD inclusive lower bound' },
    to: { type: ['string', 'null'], description: 'YYYY-MM-DD inclusive upper bound' },
    intent: {
      type: 'string',
      enum: ['recall', 'commitments', 'people', 'decisions', 'summary', 'other'],
    },
  },
  required: ['people', 'topics', 'from', 'to', 'intent'],
} as const;

export function jsonResponseFormat(schema: unknown): Record<string, unknown> {
  return { type: 'text', mime_type: 'application/json', schema };
}
