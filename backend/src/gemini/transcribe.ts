/** Source-preserving ASR. Recognized words take precedence over speaker/timing enrichment. */
import { isDigitalSilence } from './digital-silence.js';
import { config } from '../config.js';
import { offsetToMs } from '../util/retry.js';
import { log } from '../util/log.js';
import { transcriptionLanguageCodes } from './languages.js';
import type { TranscriptWord } from '../store/types.js';
import {
  createInteraction,
  interactionText,
  interactionWords,
  GeminiError,
  type InteractionPart,
  type InteractionResponse,
} from './client.js';

export interface TranscriptionReview {
  attempted: boolean;
  annotationsComplete: boolean;
  policy: 'text-first-v1';
  outcome: 'speech' | 'no-speech' | 'digital-silence';
}
export interface TranscriptionResult {
  text: string;
  words: TranscriptWord[];
  speakers: string[];
  model: string;
  review: TranscriptionReview;
}
export interface TranscribeOptions {
  baseOffsetMs?: number;
  language?: string;
  diarize?: boolean;
  wordTimestamps?: boolean;
  signal?: AbortSignal;
}

export async function transcribeSegment(
  audio: Buffer,
  mimeType: string,
  options: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const {
    baseOffsetMs = 0,
    language = 'auto',
    diarize = true,
    wordTimestamps = true,
    signal,
  } = options;
  signal?.throwIfAborted();
  const empty = (
    outcome: 'no-speech' | 'digital-silence',
    attempted: boolean,
  ): TranscriptionResult => ({
    text: '',
    words: [],
    speakers: [],
    model: config.gemini.transcribeModel,
    review: { attempted, annotationsComplete: true, policy: 'text-first-v1', outcome },
  });
  if (mimeType === 'audio/wav' && isDigitalSilence(audio)) return empty('digital-silence', false);
  const input: InteractionPart[] = [
    { type: 'audio', data: audio.toString('base64'), mime_type: mimeType },
  ];
  const languageCodes = transcriptionLanguageCodes(language);
  const run = async (settings: Record<string, unknown>, requestSignal = signal) => {
    const response = await createInteraction(
      {
        model: config.gemini.transcribeModel,
        input,
        generation_config: { transcription_config: settings },
        usage_label: 'transcription',
      },
      requestSignal,
    );
    // A missing output is a provider failure, not evidence of silence.
    if (
      !response.steps?.some(
        (step) =>
          step.type === 'model_output' &&
          step.content?.some((part) => part.type === 'text' && typeof part.text === 'string'),
      )
    )
      throw new GeminiError(
        'Transcription returned no completed text output. Saved audio is retained.',
        0,
        true,
      );
    return response;
  };
  // Google documents lower recognition accuracy with word timestamps. Keep them
  // out of the primary pass. An optional second pass can add matching labels.
  const requested = {
    mode: 'verbatim',
    ...(languageCodes ? { language_codes: languageCodes } : {}),
  };
  const variants: Record<string, unknown>[] = [requested];
  if (languageCodes) variants.push({ mode: 'verbatim' });
  variants.push({}); // Provider defaults, for a rejected optional mode setting.
  let response: InteractionResponse | undefined;
  for (let index = 0; index < variants.length; index++) {
    try {
      response = await run(variants[index]!);
      break;
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !(error instanceof GeminiError) ||
        error.status !== 400 ||
        /api[_ -]?key|credential|permission|billing|quota/i.test(error.message) ||
        index === variants.length - 1
      )
        throw error;
      log.warn('Retrying rejected transcription with fewer optional settings', {
        model: config.gemini.transcribeModel,
        stage: 'transcription',
        http_status: error.status,
        audio_bytes: audio.length,
        mime_type: mimeType,
      });
    }
  }
  if (!response) throw new GeminiError('Transcription returned no response', 0, true);
  let rawText = interactionText(response).trim(),
    attempted = false;
  if (!rawText) {
    // One fresh, automatic-language pass for an explicitly empty result. Never
    // seal transport failures as empty speech or repeatedly summarize emptiness.
    attempted = true;
    response = await run({ mode: 'verbatim' });
    rawText = interactionText(response).trim();
    if (!rawText) return empty('no-speech', true);
  }
  const convert = (value: InteractionResponse): TranscriptWord[] =>
    interactionWords(value).map((word) => ({
      text: word.text,
      speaker: word.speaker ?? null,
      start_ms: baseOffsetMs + offsetToMs(word.start_offset),
      end_ms: baseOffsetMs + offsetToMs(word.end_offset),
    }));
  let words = convert(response);
  if ((diarize || wordTimestamps) && !annotationsComplete(rawText, words)) {
    attempted = true;
    try {
      const budget = AbortSignal.timeout(15000);
      const retry = await run(
        {
          mode: {
            type: 'verbatim',
            ...(diarize ? { diarization_mode: 'speaker' } : {}),
            ...(wordTimestamps ? { timestamp_granularities: ['word'] } : {}),
          },
          ...(languageCodes ? { language_codes: languageCodes } : {}),
        },
        signal ? AbortSignal.any([signal, budget]) : budget,
      );
      const candidate = interactionText(retry).trim(),
        candidateWords = convert(retry);
      if (
        reviewText(rawText) === reviewText(candidate) &&
        annotationsComplete(candidate, candidateWords)
      )
        words = candidateWords;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  const complete = annotationsComplete(rawText, words);
  // Partial/disagreeing annotations must not feed speaker identification either.
  if (!complete) words = [];
  return {
    text: `[${formatMs(baseOffsetMs)}] S?: ${rawText}`,
    words,
    speakers: [...new Set(words.map((word) => word.speaker).filter(Boolean))].slice(
      0,
      8,
    ) as string[],
    model: config.gemini.transcribeModel,
    review: {
      attempted,
      annotationsComplete: complete,
      policy: 'text-first-v1',
      outcome: 'speech',
    },
  };
}

// Keep punctuation and symbols here: -5, 5, $5, and 5% are different evidence.
const reviewText = (text: string) =>
  text.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();

export function annotationsComplete(text: string, words: TranscriptWord[]): boolean {
  if (!text.trim()) return words.length === 0;
  return (
    words.length > 0 &&
    comparableText(text) === comparableText(words.map((word) => word.text).join(' ')) &&
    words.every(
      (word) =>
        Number.isFinite(word.start_ms) &&
        Number.isFinite(word.end_ms) &&
        word.end_ms > word.start_ms &&
        Boolean(word.speaker),
    )
  );
}

function comparableText(value: string): string {
  // Segment-level S? prefixes are provenance, not transcript words. Remove only
  // that exact synthetic form before comparing annotations with the flat text.
  const plain = value
    .replace(/^\s*\[\d{2}:\d{2}(?::\d{2})?\]\s+S\?:\s*/gm, '')
    .normalize('NFKC')
    .toLocaleLowerCase('und');
  // Ignore sentence punctuation, but not a lost sign, currency, percentage,
  // decimal, fraction, date separator, or time separator in the annotations.
  const evidence = plain.match(/[\p{S}%\-]|\p{N}*(?:[.,:/]\p{N}+)+/gu) || [];
  return JSON.stringify([plain.replace(/[\s\p{P}\p{S}]+/gu, ''), evidence]);
}

/**
 * Render diarized words back into speaker-attributed lines.
 *
 * The flat transcript is the lossless source of truth. Some ASR responses can
 * contain complete text but only partial word-level annotations. The old code
 * treated the presence of even one annotation as proof the annotations were
 * complete, so long recordings could collapse to only a few seconds. Speaker
 * formatting is now used only when the annotations reproduce the complete flat
 * transcript after punctuation/spacing normalization; otherwise the full flat
 * text wins. Because each sealed segment now carries its own timestamp prefix,
 * that fallback remains chronologically grounded too.
 */
export function toSpeakerLines(words: TranscriptWord[], fallback: string): string {
  const flat = String(fallback || '').trim();
  if (words.length === 0) return flat;

  const annotated = words
    .map((word) => String(word.text || ''))
    .join(' ')
    .trim();
  if (
    words.some(
      (word) =>
        !Number.isFinite(word.start_ms) ||
        !Number.isFinite(word.end_ms) ||
        word.end_ms <= word.start_ms,
    )
  )
    return flat || annotated;
  if (flat && comparableText(annotated) !== comparableText(flat)) return flat;

  const lines: string[] = [];
  let speaker: string | null = null;
  let buffer: string[] = [];
  let startMs = words[0]?.start_ms ?? 0;

  const flush = () => {
    if (buffer.length === 0) return;
    lines.push(`[${formatMs(startMs)}] ${speaker ?? 'S?'}: ${buffer.join(' ')}`);
    buffer = [];
  };

  for (const word of words) {
    if (word.speaker !== speaker) {
      flush();
      speaker = word.speaker;
      startMs = word.start_ms;
    }
    buffer.push(word.text);
  }
  flush();

  return lines.join('\n');
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}
