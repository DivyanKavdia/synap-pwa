/**
 * Gemini AI Studio transport.
 *
 * Talks to `generativelanguage.googleapis.com` with an API key held in Secret
 * Manager and never handed to the browser. Two surfaces are used:
 *
 *   POST /v1beta/interactions                       — the current primitive for
 *                                                     generation, transcription
 *                                                     and structured output
 *   POST /v1beta/models/{model}:embedContent        — retrieval vectors
 *
 * `store: false` is set on every interaction so Google keeps no server-side
 * copy of the conversation state. Synap's whole proposition is that a person's
 * days stay theirs; leaving generation state on someone else's server by
 * default would quietly undo that.
 */

import { config, loadSecrets } from '../config.js';
import { log } from '../util/log.js';
import { sleep } from '../util/retry.js';

export interface InteractionTextPart {
  type: 'text';
  text: string;
}

export interface InteractionAudioPart {
  type: 'audio';
  data: string;
  mime_type: string;
}

export type InteractionPart = InteractionTextPart | InteractionAudioPart;

export interface WordAnnotation {
  type: 'word_info';
  text: string;
  speaker?: string;
  start_offset?: string;
  end_offset?: string;
}

interface InteractionContent {
  type: string;
  text?: string;
  annotations?: WordAnnotation[];
}

interface InteractionStep {
  type: string;
  content?: InteractionContent[];
}

export interface InteractionResponse {
  id?: string;
  status?: string;
  steps?: InteractionStep[];
  usage?: Record<string, number>;
}

export interface InteractionRequest {
  model: string;
  input: string | InteractionPart[];
  system_instruction?: string;
  generation_config?: Record<string, unknown>;
  response_format?: Record<string, unknown>;
  /** Internal-only billing label. Stripped before the request is sent. */
  usage_label?: string;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

async function call<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const { geminiApiKey } = await loadSecrets();
  const url = `${config.gemini.endpoint}${path}`;

  let lastError: GeminiError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.gemini.requestTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': geminiApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.ok) return (await response.json()) as T;

      const detail = await response.text().catch(() => '');
      const error = new GeminiError(
        `Gemini HTTP ${response.status}: ${detail.slice(0, 400)}`,
        response.status,
        RETRYABLE_STATUS.has(response.status),
      );
      if (!error.retryable || attempt === MAX_ATTEMPTS) throw error;
      lastError = error;
    } catch (cause) {
      if (cause instanceof GeminiError) {
        if (!cause.retryable || attempt === MAX_ATTEMPTS) throw cause;
        lastError = cause;
      } else if ((cause as Error).name === 'AbortError' && signal?.aborted) {
        throw cause;
      } else {
        // Network-level failure: worth retrying, the request never landed.
        const error = new GeminiError(`Gemini request failed: ${(cause as Error).message}`, 0, true);
        if (attempt === MAX_ATTEMPTS) throw error;
        lastError = error;
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }

    // Full jitter backoff; a thundering herd of retried segments is the
    // failure mode that turns a blip into an outage.
    const ceiling = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    await sleep(Math.random() * ceiling);
  }

  throw lastError ?? new GeminiError('Gemini request failed', 0, false);
}

/**
 * Emit only numeric usage counters. Never log prompts, responses, transcript
 * text or identifiers from user content. Cloud Logging can aggregate these
 * fields by model and stage to explain billing without weakening privacy.
 */
export function usageLogFields(
  model: string,
  label: string | undefined,
  usage: Record<string, number> | undefined,
): Record<string, unknown> | null {
  if (!usage) return null;
  const fields: Record<string, unknown> = { model, stage: label || 'unspecified' };
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number' && Number.isFinite(value)) fields[`usage_${key}`] = value;
  }
  return fields;
}

export async function createInteraction(
  request: InteractionRequest,
  signal?: AbortSignal,
): Promise<InteractionResponse> {
  const { usage_label: usageLabel, ...apiRequest } = request;
  const response = await call<InteractionResponse>('/interactions', { ...apiRequest, store: false }, signal);
  const fields = usageLogFields(request.model, usageLabel, response.usage);
  if (fields) log.info('Gemini usage', fields);
  return response;
}

/** Concatenate the text content of every model output step. */
export function interactionText(response: InteractionResponse): string {
  const parts: string[] = [];
  for (const step of response.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const content of step.content ?? []) {
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

/** Word-level annotations, present when diarization or timestamps are enabled. */
export function interactionWords(response: InteractionResponse): WordAnnotation[] {
  const words: WordAnnotation[] = [];
  for (const step of response.steps ?? []) {
    for (const content of step.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        if (annotation.type === 'word_info') words.push(annotation);
      }
    }
  }
  return words;
}

/**
 * Parse a structured-output response. The model is constrained by
 * `response_format`, but a malformed body is still possible on truncation, so
 * this never assumes success.
 */
export function interactionJson<T>(response: InteractionResponse): T {
  const text = interactionText(response);
  if (!text) throw new GeminiError('Gemini returned no text content', 0, true);
  try {
    return JSON.parse(text) as T;
  } catch {
    // Models occasionally wrap JSON in a fence despite the schema constraint.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) return JSON.parse(fenced[1]) as T;
    throw new GeminiError('Gemini structured output was not valid JSON', 0, true);
  }
}

export interface EmbedResponse {
  embedding?: { values?: number[] };
}

export type EmbedTaskType =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY'
  | 'QUESTION_ANSWERING';

export async function embedContent(
  text: string,
  taskType: EmbedTaskType,
  signal?: AbortSignal,
): Promise<number[]> {
  const response = await call<EmbedResponse>(
    `/models/${config.gemini.embedModel}:embedContent`,
    {
      content: { parts: [{ text }] },
      taskType,
      output_dimensionality: config.gemini.embedDimensions,
    },
    signal,
  );
  const values = response.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new GeminiError('Gemini returned an empty embedding', 0, true);
  }
  // Truncated Matryoshka embeddings need renormalizing before cosine distance.
  return normalize(values);
}

export function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const magnitude = Math.sqrt(sum);
  if (!magnitude || !Number.isFinite(magnitude)) return vector;
  return vector.map((value) => value / magnitude);
}
