/** Source-preserving ASR. Recognized words take precedence over speaker/timing enrichment. */
import {
  originalAudio,
  prepareTranscriptionAudio,
  type TranscriptionAudio,
} from './transcription-audio.js';
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
  uploadGeminiFile,
  deleteGeminiFile,
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
export interface TranscriptionAudioUsage {
  policy: 'atempo-1.5-v1' | 'stored-upload-v1';
  speed: 1 | 1.5;
  sourceDurationMs: number;
  preparedDurationMs: number;
  submittedAudioMs: number;
  requestAttempts: number;
  fallback?: TranscriptionAudio['fallback'];
}
export interface TranscriptionResult {
  text: string;
  words: TranscriptWord[];
  speakers: string[];
  model: string;
  review: TranscriptionReview;
  audioUsage?: TranscriptionAudioUsage;
}
export interface TranscribeOptions {
  baseOffsetMs?: number;
  speed?: 1 | 1.5;
  language?: string;
  diarize?: boolean;
  wordTimestamps?: boolean;
  /** Require word timestamps in the primary pass so a long ASR batch can be
   * deterministically split back into durable 30-second source windows. */
  primaryWordTimestamps?: boolean;
  /** Use a Gemini Files API reference instead of embedding audio inline. */
  useFileApi?: boolean;
  /** Extra audio submission; opt in only when a caller explicitly needs labels. */
  enrichAnnotations?: boolean;
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
  let prepared: TranscriptionAudio | undefined;
  let submittedAudioMs = 0,
    requestAttempts = 0;
  const audioUsage = (): TranscriptionAudioUsage | undefined =>
    prepared
      ? {
          policy: prepared.speed === 1.5 ? 'atempo-1.5-v1' : 'stored-upload-v1',
          speed: prepared.speed,
          sourceDurationMs: prepared.sourceDurationMs,
          preparedDurationMs: prepared.durationMs,
          submittedAudioMs,
          requestAttempts,
          ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
        }
      : undefined;
  const empty = (
    outcome: 'no-speech' | 'digital-silence',
    attempted: boolean,
  ): TranscriptionResult => ({
    text: '',
    words: [],
    speakers: [],
    model: config.gemini.transcribeModel,
    review: { attempted, annotationsComplete: true, policy: 'text-first-v1', outcome },
    audioUsage: audioUsage(),
  });
  if (mimeType === 'audio/wav' && isDigitalSilence(audio)) {
    prepared = originalAudio(audio);
    return empty('digital-silence', false);
  }
  if (mimeType === 'audio/wav' && options.speed)
    prepared = await prepareTranscriptionAudio(audio, options.speed, signal);
  const languageCodes = transcriptionLanguageCodes(language);
  const run = async (settings: Record<string, unknown>, requestSignal = signal) => {
    const submitted = prepared?.audio || audio;
    let uploaded: Awaited<ReturnType<typeof uploadGeminiFile>> | undefined;
    let input: InteractionPart[];
    try {
      if (options.useFileApi) {
        uploaded = await uploadGeminiFile(submitted, mimeType, requestSignal);
        input = [{ type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType || mimeType }];
      } else {
        input = [{ type: 'audio', data: submitted.toString('base64'), mime_type: mimeType }];
      }
      const response = await createInteraction(
        {
          model: config.gemini.transcribeModel,
          input,
          generation_config: { transcription_config: settings },
          usage_label: 'transcription',
        },
        requestSignal,
        () => {
          requestAttempts++;
          submittedAudioMs += prepared?.durationMs || 0;
          // Counts model submissions only. Files API upload traffic is separate
          // and does not multiply the model's RPM/RPD quota.
          log.info('Transcription audio submission', {
            model: config.gemini.transcribeModel,
            speed: prepared?.speed || 1,
            audio_ms: prepared?.durationMs || 0,
            attempt: requestAttempts,
            transport: options.useFileApi ? 'file-uri' : 'inline',
          });
        },
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
        'missing-text',
        undefined,
        { model: config.gemini.transcribeModel, stage: 'transcription' },
      );
      return response;
    } finally {
      if (uploaded) await deleteGeminiFile(uploaded);
    }
  };
  // Long-batch mode deliberately enables word timestamps in the primary pass:
  // they are the deterministic boundary map back to the encrypted 30-second
  // source windows. Ordinary single-window ASR keeps Google's higher-accuracy
  // text-first mode and requests annotations only when explicitly needed.
  const primaryMode = options.primaryWordTimestamps
    ? { type: 'verbatim', timestamp_granularities: ['word'] }
    : 'verbatim';
  const requested = {
    mode: primaryMode,
    ...(languageCodes ? { language_codes: languageCodes } : {}),
  };
  const variants: Record<string, unknown>[] = [requested];
  if (languageCodes) variants.push({ mode: primaryMode });
  if (!options.primaryWordTimestamps)
    variants.push({}); // Compatibility fallback is unsafe when timestamps are required for splitting.
  let response: InteractionResponse | undefined;
  let attempted = false;
  try {
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
  } catch (error) {
    signal?.throwIfAborted();
    const resultFailure =
      error instanceof GeminiError &&
      (error.reason === 'incomplete' || error.reason === 'missing-text');
    const acceleratedRejection =
      prepared?.speed === 1.5 &&
      error instanceof GeminiError &&
      error.status === 400 &&
      !/api[_ -]?key|credential|permission|billing|quota/i.test(error.message);
    // Missing/incomplete output already consumed a provider request. Do not
    // submit the same audio again inside this request: the durable recording
    // retry owns recovery after its 120-second delay. This is the boundary that
    // prevents one anomalous ASR response from becoming an RPM/RPD burst.
    if (resultFailure) throw error;
    if (mimeType !== 'audio/wav' || !acceleratedRejection) throw error;
    // A deterministic 400 is request-shape compatibility, not a transient
    // provider failure. Retrying once with original input/default settings
    // remains useful and cannot be confused with quota recovery.
    attempted = true;
    prepared = { ...originalAudio(audio), fallback: 'provider-failure' };
    log.warn('Retrying transcription with original audio and default settings', {
      model: config.gemini.transcribeModel,
      stage: 'transcription',
      reason: error.reason,
      http_status: error.status,
      source_duration_ms: prepared.sourceDurationMs,
    });
    response = await run({});
  }
  if (!response) throw new GeminiError('Transcription returned no response', 0, true);
  let rawText = interactionText(response).trim();
  if (!rawText) {
    // One fresh, automatic-language pass for an explicitly empty result. Never
    // seal transport failures as empty speech or repeatedly summarize emptiness.
    attempted = true;
    if (prepared?.speed === 1.5)
      prepared = { ...originalAudio(audio), fallback: 'empty-recognition' };
    response = await run({ mode: primaryMode });
    rawText = interactionText(response).trim();
    if (!rawText) return empty('no-speech', true);
  }
  const sourceOffset = (offset: string | undefined) => {
    const ms = offsetToMs(offset) * (prepared?.speed || 1);
    return (
      baseOffsetMs +
      Math.round(prepared ? Math.min(prepared.sourceDurationMs, Math.max(0, ms)) : ms)
    );
  };
  const convert = (value: InteractionResponse): TranscriptWord[] =>
    interactionWords(value).map((word) => ({
      text: word.text,
      speaker: word.speaker ?? null,
      start_ms: sourceOffset(word.start_offset),
      end_ms: sourceOffset(word.end_offset),
    }));
  let words = convert(response);
  if (options.enrichAnnotations === true && (diarize || wordTimestamps) && !annotationsComplete(rawText, words)) {
    attempted = true;
    try {
      const budget = AbortSignal.timeout(45000);
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
      // Optional labels must not discard a completed primary transcript when
      // the window's time budget runs out. Explicit cancellation still wins.
      if (signal?.aborted && signal.reason?.name !== 'TimeoutError') throw error;
    }
  }
  const complete = options.primaryWordTimestamps
    ? timestampAnnotationsComplete(rawText, words)
    : annotationsComplete(rawText, words);
  if (options.primaryWordTimestamps && !complete)
    throw new GeminiError(
      'Long transcription batch returned incomplete word timestamps. Saved audio is retained.',
      0,
      true,
      'incomplete',
      undefined,
      { model: config.gemini.transcribeModel, stage: 'transcription' },
    );
  // Partial/disagreeing optional annotations must not feed speaker identification.
  if (!complete) words = [];
  return {
    text: `[${formatMs(baseOffsetMs)}] S?: ${rawText}`,
    words,
    speakers: [...new Set(words.map((word) => word.speaker).filter(Boolean))].slice(
      0,
      8,
    ) as string[],
    model: config.gemini.transcribeModel,
    audioUsage: audioUsage(),
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

export function timestampAnnotationsComplete(text: string, words: TranscriptWord[]): boolean {
  if (!text.trim()) return words.length === 0;
  return (
    words.length > 0 &&
    comparableText(text) === comparableText(words.map((word) => word.text).join(' ')) &&
    words.every(
      (word) =>
        Number.isFinite(word.start_ms) &&
        Number.isFinite(word.end_ms) &&
        word.end_ms > word.start_ms,
    )
  );
}

export function annotationsComplete(text: string, words: TranscriptWord[]): boolean {
  return timestampAnnotationsComplete(text, words) && words.every((word) => Boolean(word.speaker));
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
