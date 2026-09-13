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

import { speechWindow } from './speech-window.js';
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

export interface TranscriptionResult {
  text: string;
  words: TranscriptWord[];
  speakers: string[];
  model: string;
  review: { attempted: boolean; annotationsComplete: boolean };
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

  if(signal?.aborted)throw signal.reason;
  const prepared=mimeType==='audio/wav' ? speechWindow(audio) : {audio,offsetMs:0,silent:false};
  if(prepared.silent)return {text:'',words:[],speakers:[],model:config.gemini.transcribeModel,review:{attempted:false,annotationsComplete:true}};
  const sourceOffsetMs=baseOffsetMs+prepared.offsetMs;
  const input: InteractionPart[] = [
    { type: 'audio', data: prepared.audio.toString('base64'), mime_type: mimeType },
  ];

  const mode: Record<string, unknown> = { type: 'verbatim' };
  if (diarize) mode.diarization_mode = 'speaker';
  if (wordTimestamps) mode.timestamp_granularities = ['word'];

  const transcriptionConfig: Record<string, unknown> = {
    mode: diarize || wordTimestamps ? mode : 'verbatim',
  };
  const languageCodes = transcriptionLanguageCodes(language);
  if (languageCodes) transcriptionConfig.language_codes = languageCodes;

  const run = (settings: Record<string, unknown>, requestSignal=signal) => createInteraction(
    {
      model: config.gemini.transcribeModel,
      input,
      generation_config: { transcription_config: settings },
      usage_label: 'transcription',
    },
    requestSignal,
  );

  // A 400 is not a transient failure: repeating the same body cannot fix it.
  // First remove the language hint while keeping full annotations. Only if the
  // provider still rejects the request, fall back to plain verbatim ASR. Keep
  // the exact audio and store:false on every attempt; never invent lost timing.
  const variants = [{ settings: transcriptionConfig, label: 'requested', annotations: true }];
  if (languageCodes) variants.push({
    settings: { mode: transcriptionConfig.mode }, label: 'automatic_language', annotations: true,
  });
  if (diarize || wordTimestamps) variants.push({
    settings: { mode: 'verbatim' }, label: 'plain_transcription', annotations: false,
  });

  let response: InteractionResponse | undefined;
  let selected = variants[0]!;
  for (let index = 0; index < variants.length; index++) {
    selected = variants[index]!;
    try {
      response = await run(selected.settings);
      break;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof GeminiError) || error.status !== 400 ||
          /api[_ -]?key|credential|permission|billing|quota/i.test(error.message) ||
          index === variants.length - 1) throw error;
      log.warn('Retrying rejected transcription with fewer optional settings', {
        model: config.gemini.transcribeModel, stage: 'transcription', http_status: error.status,
        fallback: variants[index + 1]!.label, audio_bytes: prepared.audio.length, mime_type: mimeType,
      });
    }
  }
  if (!response) throw new GeminiError('Transcription returned no response', 0, true);
  let rawText=interactionText(response).trim();
  const convert = (value: typeof response):TranscriptWord[] => interactionWords(value).map((word) => ({
    text: word.text,
    speaker: word.speaker ?? null,
    start_ms: sourceOffsetMs + offsetToMs(word.start_offset),
    end_ms: sourceOffsetMs + offsetToMs(word.end_offset),
  }));
  let words=convert(response),attempted=false;
  if(selected.annotations && diarize && wordTimestamps && (rawText || words.length) && !annotationsComplete(rawText,words)) {
    attempted=true;
    try {
      const budget=AbortSignal.timeout(15000);
      const retry=await run(selected.settings,signal ? AbortSignal.any([signal,budget]) : budget),candidate=interactionText(retry).trim(),candidateWords=convert(retry);
      // A second pass may repair annotations, but must not silently rewrite
      // already-recognized words. Disagreement keeps the first complete text.
      if((!rawText || reviewText(rawText)===reviewText(candidate)) && annotationsComplete(candidate,candidateWords)) {
        rawText=rawText||candidate;words=candidateWords;
      }
    } catch(error) { if(signal?.aborted)throw error; }
  }

  const speakers = [...new Set(words.map((word) => word.speaker).filter(Boolean))] as string[];

  /*
   * Keep every sealed segment self-grounding even when Gemini returns only
   * partial/missing word annotations. `understand()` joins segment transcripts;
   * without this prefix, an all-or-nothing diarization fallback turns the full
   * capture into untimed prose and the memory extractor has no evidence for
   * conversation offsets (historically several conversations became 0 ms).
   *
   * `toSpeakerLines()` strips this presentation prefix for its completeness
   * comparison, so fully annotated captures still render with real speaker
   * labels and word-derived timestamps.
   */
  const text = rawText ? `[${formatMs(sourceOffsetMs)}] S?: ${rawText}` : '';

  return {
    text,
    words,
    // Diarization is documented as experimental beyond three speakers and capped
    // at eight, so a longer list means the labels are not to be trusted.
    speakers: speakers.slice(0, MAX_SPEAKERS_NOTE),
    model: config.gemini.transcribeModel,
    review:{attempted,annotationsComplete:annotationsComplete(rawText,words)},
  };
}

// Keep punctuation and symbols here: -5, 5, $5, and 5% are different evidence.
const reviewText=(text:string)=>text.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu,' ').trim();

export function annotationsComplete(text:string,words:TranscriptWord[]):boolean {
  if(!text.trim())return words.length===0;
  return words.length>0 && comparableText(text)===comparableText(words.map(word=>word.text).join(' ')) &&
    words.every(word=>Number.isFinite(word.start_ms)&&Number.isFinite(word.end_ms)&&word.end_ms>word.start_ms&&Boolean(word.speaker));
}

function comparableText(value: string): string {
  // Segment-level S? prefixes are provenance, not transcript words. Remove only
  // that exact synthetic form before comparing annotations with the flat text.
  const plain=value
    .replace(/^\s*\[\d{2}:\d{2}(?::\d{2})?\]\s+S\?:\s*/gm, '')
    .normalize('NFKC')
    .toLocaleLowerCase('und');
  // Ignore sentence punctuation, but not a lost sign, currency, percentage,
  // decimal, fraction, date separator, or time separator in the annotations.
  const evidence=plain.match(/[\p{S}%\-]|\p{N}*(?:[.,:/]\p{N}+)+/gu)||[];
  return JSON.stringify([plain.replace(/[\s\p{P}\p{S}]+/gu,''),evidence]);
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

  const annotated = words.map((word) => String(word.text || '')).join(' ').trim();
  if(words.some(word=>!Number.isFinite(word.start_ms)||!Number.isFinite(word.end_ms)||word.end_ms<=word.start_ms))return flat||annotated;
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
