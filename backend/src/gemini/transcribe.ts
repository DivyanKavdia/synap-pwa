/**
 * Speech to text.
 *
 * Uses the dedicated ASR model rather than a general multimodal model. That
 * choice is load-bearing for Synap: pendant capture is ambient Indian-office
 * speech, which code-switches between Hindi and English inside a single
 * sentence. The transcription model auto-detects across 85+ languages and
 * handles mid-utterance switching, which a language-pinned ASR cannot.
 *
 * One documented incompatibility shapes the design: `custom_vocabulary` cannot
 * be combined with diarization or word timestamps — the API rejects the
 * combination outright. Synap wants speaker labels and timings far more than it
 * wants vocabulary hints at the ASR stage, so custom vocabulary is applied
 * later, during memory extraction, where confirmed people names can be supplied
 * as context without fighting the transcriber.
 */

import { config } from '../config.js';
import { offsetToMs } from '../util/retry.js';
import type { TranscriptWord } from '../store/types.js';
import {
  createInteraction,
  interactionText,
  interactionWords,
  type InteractionPart,
} from './client.js';

export interface TranscriptionResult {
  text: string;
  words: TranscriptWord[];
  speakers: string[];
  model: string;
}

export interface TranscribeOptions {
  /** Offset of this segment inside the recording, added to word timings. */
  baseOffsetMs?: number;
  /** IETF tag such as `hi-IN`, or `auto` to let the model decide. */
  language?: string;
  diarize?: boolean;
  wordTimestamps?: boolean;
  signal?: AbortSignal;
}

const MAX_SPEAKERS_NOTE = 8;

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

  const input: InteractionPart[] = [
    { type: 'audio', data: audio.toString('base64'), mime_type: mimeType },
  ];

  const mode: Record<string, unknown> = { type: 'verbatim' };
  if (diarize) mode.diarization_mode = 'speaker';
  if (wordTimestamps) mode.timestamp_granularities = ['word'];

  const transcriptionConfig: Record<string, unknown> = { mode };
  if (language && language !== 'auto') transcriptionConfig.language_codes = [language];

  const response = await createInteraction(
    {
      model: config.gemini.transcribeModel,
      input,
      generation_config: { transcription_config: transcriptionConfig },
      usage_label: 'transcription',
    },
    signal,
  );

  const text = interactionText(response);
  const words: TranscriptWord[] = interactionWords(response).map((word) => ({
    text: word.text,
    speaker: word.speaker ?? null,
    start_ms: baseOffsetMs + offsetToMs(word.start_offset),
    end_ms: baseOffsetMs + offsetToMs(word.end_offset),
  }));

  const speakers = [...new Set(words.map((word) => word.speaker).filter(Boolean))] as string[];

  return {
    text: text.trim(),
    words,
    // Diarization is documented as experimental beyond three speakers and capped
    // at eight, so a longer list means the labels are not to be trusted.
    speakers: speakers.slice(0, MAX_SPEAKERS_NOTE),
    model: config.gemini.transcribeModel,
  };
}

function comparableText(value: string): string {
  // Word annotations naturally omit punctuation/spacing. Strip only those
  // presentation differences; any remaining mismatch means the annotations are
  // not a lossless representation of the flat transcript.
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
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
 * text wins.
 */
export function toSpeakerLines(words: TranscriptWord[], fallback: string): string {
  const flat = String(fallback || '').trim();
  if (words.length === 0) return flat;

  const annotated = words.map((word) => String(word.text || '')).join(' ').trim();
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
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
