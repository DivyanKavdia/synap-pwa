/**
 * The processing pipeline: audio in, memory out.
 *
 *   uploaded → transcribing → understanding → indexing → ready
 *
 * Each stage is restart-safe and picks up where the last left off. A segment
 * that already has a sealed transcript is never re-transcribed, so a crash
 * halfway through an hour-long capture costs the remaining segments and nothing
 * else. That property is what makes the Cloud Tasks retry policy safe to leave
 * aggressive.
 */

import { config } from '../config.js';
import { keyring } from '../crypto/keyring.js';
import {
  openBytes,
  openJson,
  openText,
  sealJson,
  sealText,
  type Binding,
} from '../crypto/envelope.js';
import { extractMemory } from '../gemini/memory.js';
import { GeminiError, modelFailure } from '../gemini/client.js';
import { formatMs, toSpeakerLines } from '../gemini/transcribe.js';
import { tagSelfSpeaker } from '../speaker/enrich.js';
import { RecordingSpeakers, labelWords } from '../speaker/diarization.js';
import { extractSpeakerSample } from '../speaker/audio.js';
import { embedSpeakerAudio, speakerServiceConfigured, type SpeakerEmbeddingResult } from '../speaker/client.js';
import { readKnownSpeakers, identifyKnownSpeakers, mergeSpeakerIdentifications, type KnownSpeaker } from '../speaker/known.js';
import { applySpeakerNames, readSpeakerNames } from '../speaker/names.js';
import * as db from '../store/firestore.js';
import { readSealedSegment } from '../store/gcs.js';
import type {
  RecordingDoc,
  SegmentDoc,
  StructuredMemory,
  TranscriptWord,
} from '../store/types.js';
import { newId, sha256 } from '../util/ids.js';
import { log } from '../util/log.js';
import { rebuildDay } from './brief.js';
import { indexMemory } from './index-memory.js';
import { chooseTranscript } from './source-materialize.js';
import { transcribeUploadedWindow, hasUsableTranscription } from './rolling-transcription.js';
import { requireCompleteSegments, transcribeRecordingSegments } from './recording-segments.js';

const SEGMENT_MS = 30_000;

export interface ProcessRecordingOptions {
  /** Reuse sealed segment transcripts only. Missing transcript windows are an error; never call STT. */
  skipTranscription?: boolean;
  /** Refresh the sealed recording memory/day brief without rewriting retrieval/people/follow-up indexes. */
  memoryOnly?: boolean;
}

export function binding(uid: string, scope: string, field: string): Binding {
  return { uid, scope, field };
}

export function processingFailure(cause: unknown): NonNullable<RecordingDoc['processingFailure']> {
  if (cause instanceof GeminiError) return modelFailure(cause);
  const message = (cause as Error)?.message || 'Processing failed';
  const explicit = (cause as { retryable?: boolean })?.retryable;
  return { code: cause instanceof db.TranscriptionBusyError ? cause.code : 'processing_failed', message,
    ...(cause instanceof db.TranscriptionBusyError ? { retryAfterMs: cause.retryAfterMs } : {}),
    retryable: typeof explicit === 'boolean' ? explicit : !/unknown (user|recording)|not found|no segments|no audio/i.test(message) };
}

/**
 * Old segment transcripts predate segment-level timestamp prefixes. Preserve the
 * exact text but anchor the whole sealed 30-second window at its recorded start.
 * New transcripts are already grounded and are left untouched. This is what
 * lets a memory-only rebuild recover chronology without paying for STT again.
 */
export function groundSegmentTranscript(text: string, startMs: number): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (/^\[\d{2}:\d{2}(?::\d{2})?\]\s+[^:]+:/u.test(trimmed)) return trimmed;
  return `[${formatMs(startMs)}] S?: ${trimmed}`;
}

export async function processRecording(
  uid: string,
  recordingId: string,
  options: ProcessRecordingOptions = {},
): Promise<void> {
  const user = await db.getUser(uid);
  if (!user) throw new Error(`Unknown user ${uid}`);
  const dek = await keyring.unwrap(uid, user.key);
  const lease = newId();
  const recording = await db.claimProcessing(uid, recordingId, lease, Boolean(options.memoryOnly));
  if (recording.state === 'ready' && !options.memoryOnly) {
    // A previous attempt may have published the memory but failed to refresh
    // its day. Queue retries repair only this inexpensive derived view.
    await rebuildDay(uid, recording.day, dek);
    return;
  }
  const patch = (fields: Partial<RecordingDoc>) => db.patchProcessing(uid, recordingId, lease, fields);
  try {
    let memory: StructuredMemory;
    if (recording.sealedMemory && recording.sealedTranscript && !options.memoryOnly) {
      // Understanding completed durably. Reuse it after an index/storage fault,
      // preserving task identities and avoiding another paid model call.
      memory = openJson<StructuredMemory>(dek, recording.sealedMemory, binding(uid, `recording/${recordingId}`, 'memory'));
    } else {
      let segments: SegmentDoc[];
      if (options.skipTranscription) {
        segments = await db.listSegments(uid, recordingId);
        segments = requireCompleteSegments(segments, recording.segmentCount || segments.length);
        const missing = segments.filter((segment) => !segment.sealedTranscript);
        if (missing.length) throw new Error(`Transcript-only rebuild requires every sealed segment transcript; ${missing.length} window(s) are missing`);
      } else {
        segments = await transcribeAll(uid, recordingId, dek, recording, patch);
      }
      await patch({ state: 'understanding', progress: 0.55 });
      memory = await understand(uid, recordingId, dek, recording, segments, patch, lease);
    }
    if (options.memoryOnly) {
      await patch({ state: 'ready', progress: 1, errorCode: null, retryable: false, processingLease: null });
    } else {
      await patch({ state: 'indexing', progress: 0.8 });
      const source = await db.getRecording(uid, recordingId);
      if (!source) throw new Error('Unknown recording');
      if (source.processingLease !== lease) throw new Error('Processing attempt was superseded');
      await indexMemory(uid, dek, source, memory, lease);
    }
    log.info('Recording processed', { uid, recordingId, conversations: memory.conversations.length, memoryOnly: Boolean(options.memoryOnly) });
  } catch (cause) {
    const failure = processingFailure(cause);
    const { message, retryable } = failure;
    log.error('Processing failed', { uid, recordingId, error: message, retryable });
    try {
      // The fence also prevents a delayed failure from undoing another worker's
      // success or resurrecting a recording the user deleted.
      await patch(options.memoryOnly && recording.state === 'ready'
        ? { state: 'ready', progress: 1, errorCode: null, retryable: false, processingLease: null }
        : { state: 'failed', errorCode: message.slice(0, 200), retryable, processingLease: null,
          processingFailure: { ...failure, message: message.slice(0, 200),
            ...(failure.retryAfterMs ? { retryAt: Date.now() + failure.retryAfterMs } : {}) } });
    } catch { /* A deleted recording or superseded attempt belongs to its current owner. */ }
    throw cause;
  }
  // The memory is already ready. A transient brief failure must not change that
  // result; throwing here asks Cloud Tasks to retry just the day refresh above.
  await rebuildDay(uid, recording.day, dek);
}

// ---------------------------------------------------------------------------
// Stage 1 — transcription
// ---------------------------------------------------------------------------

async function transcribeAll(
  uid: string,
  recordingId: string,
  dek: Buffer,
  recording: RecordingDoc,
  patch: (fields: Partial<RecordingDoc>) => Promise<void>,
): Promise<SegmentDoc[]> {
  const segments = await db.listSegments(uid, recordingId);
  return transcribeRecordingSegments(
    segments,
    recording.segmentCount || segments.length,
    segment => transcribeUploadedWindow(uid, recordingId, segment.index, dek),
    (done, total) => patch({ progress: 0.05 + 0.5 * (done / total) }),
    segment => !hasUsableTranscription(uid, recordingId, dek, segment),
  );
}

// ---------------------------------------------------------------------------
// Stage 2 — understanding
// ---------------------------------------------------------------------------

async function enrichSegmentWords(
  uid: string,
  recordingId: string,
  dek: Buffer,
  segment: SegmentDoc,
  segmentWords: TranscriptWord[],
  diarizer: RecordingSpeakers,
  preserveNames: boolean,
  knownVoices: KnownSpeaker[],
  identified: Record<string,string>,
  conflicts: Set<string>,
  lease: string,
): Promise<TranscriptWord[]> {
  if (segmentWords.length === 0) return segmentWords;
  if (preserveNames) {
    // A user's saved name is bound to these exact labels; never renumber them
    // during a later summary refresh or a temporary speaker-service outage.
    return segment.sealedSpeakerMap
      ? labelWords(segmentWords, openJson<Record<string,string>>(dek, segment.sealedSpeakerMap, binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'speaker-map')))
      : segmentWords;
  }
  let audio: Buffer | null = null;
  let enriched = segmentWords;
  const cached=new Map<string,Promise<SpeakerEmbeddingResult>>();
  const embed=(wav:Buffer)=>{
    const key=sha256(wav);let value=cached.get(key);
    if(!value){value=embedSpeakerAudio(wav);cached.set(key,value)}return value;
  };
  try {
    const sealed = segment.storagePath ? await readSealedSegment(segment.storagePath) : null;
    if (sealed) audio = openBytes(
      dek,
      sealed,
      binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'audio'),
    );
    if(audio) enriched = (await tagSelfSpeaker(uid, dek, audio, segmentWords, segment.startMs, embed)).words;
  } catch (cause) {
    // Identity is metadata enrichment, never a prerequisite for a transcript.
    log.warn('Could not enrich one segment with voice profile', {
      uid,
      recordingId,
      index: segment.index,
      error: (cause as Error).message,
    });
  }
  const voices=new Map<string,SpeakerEmbeddingResult>();
  const mapping = await diarizer.mapWindow(segment.index, enriched, audio && speakerServiceConfigured() ? async speaker => {
    const sample = extractSpeakerSample(audio!, enriched, speaker, segment.startMs, config.speaker.minSampleMs, config.speaker.maxSampleMs);
    if(!sample)return null;
    const voice=await embed(sample.wav);voices.set(speaker,voice);return voice;
  } : undefined);
  // Include the wearer as a competing voice: a saved wearer profile must not
  // accidentally name a different speaker just because YOU was filtered out.
  if(audio && knownVoices.length && enriched.some(word=>word.speaker==='YOU')) {
    try{
      const sample=extractSpeakerSample(audio,enriched,'YOU',segment.startMs,config.speaker.minSampleMs,config.speaker.maxSampleMs);
      if(sample){voices.set('YOU',await embed(sample.wav));mapping.YOU='YOU'}
    }catch{ /* Existing self labeling remains available without a saved-name match. */ }
  }
  mergeSpeakerIdentifications(mapping,voices.keys(),identifyKnownSpeakers(voices,knownVoices),identified,conflicts);
  // Include an enrolled-self match so later user naming stays stable as well.
  for(let i=0;i<segmentWords.length;i++) if(segmentWords[i]!.speaker && enriched[i]!.speaker==='YOU') mapping[segmentWords[i]!.speaker!]='YOU';
  await db.saveSegmentSpeakerMap(uid, recordingId, segment, lease, sealJson(dek,mapping,binding(uid,`recording/${recordingId}/segment/${segment.index}`,'speaker-map')));
  return labelWords(enriched,mapping);
}

async function understand(
  uid: string,
  recordingId: string,
  dek: Buffer,
  recording: RecordingDoc,
  segments: SegmentDoc[],
  patch: (fields: Partial<RecordingDoc>) => Promise<void>,
  lease: string,
): Promise<StructuredMemory> {
  const flat: string[] = [];
  const diarizer = new RecordingSpeakers();
  let knownVoices:KnownSpeaker[]=[];
  try{knownVoices=await readKnownSpeakers(uid,dek)}catch{log.warn('Saved voice lookup unavailable; continuing with anonymous speakers',{uid,recordingId})}
  const identified:Record<string,string>=Object.create(null),conflicts=new Set<string>();

  for (const segment of segments.slice().sort((a,b)=>a.index-b.index)) {
    const scope = `recording/${recordingId}/segment/${segment.index}`;
    let grounded = '';
    if (segment.sealedTranscript) {
      const text = openText(dek, segment.sealedTranscript, binding(uid, scope, 'transcript'));
      grounded = groundSegmentTranscript(text, segment.startMs);
    }
    if (segment.sealedWords) {
      const segmentWords = openJson<TranscriptWord[]>(dek, segment.sealedWords, binding(uid, scope, 'words'));
      const words = await enrichSegmentWords(uid, recordingId, dek, segment, segmentWords, diarizer, Boolean(recording.sealedSpeakerNames),knownVoices,identified,conflicts,lease);
      // Validate completeness per window: one partial annotation set must not
      // erase valid speaker labels in every other window of the recording.
      grounded = toSpeakerLines(words, grounded);
    }
    if(grounded)flat.push(grounded);
  }

  let transcript = flat.join('\n');
  if(recording.sealedSpeakerNames && recording.sealedTranscript) {
    const original=openText(dek,recording.sealedTranscript,binding(uid,`recording/${recordingId}`,'transcript'));
    transcript=chooseTranscript(original,flat).text;
  }

  const highlights = await db.listHighlights(uid, recordingId);
  const people = await db.listPeople(uid, 100);
  const knownPeople = people
    .filter((person) => person.confirmedByUser)
    .map((person) => {
      try {
        return openJson<{ name: string }>(
          dek,
          person.sealedProfile,
          binding(uid, `person/${person.personId}`, 'profile'),
        ).name;
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  const durationMs = recording.durationMs || segments.length * SEGMENT_MS;

  const confirmedSpeakers = recording.sealedSpeakerNames ? readSpeakerNames(uid, recording, dek) : {};
  const speakerNames = recording.sealedSpeakerNames ? confirmedSpeakers : identified;
  const memory = await extractMemory({
    startedAt: recording.startedAt,
    day: recording.day,
    timezone: recording.timezone,
    transcript: applySpeakerNames(transcript, speakerNames),
    confirmedSpeakers,
    identifiedSpeakers:recording.sealedSpeakerNames ? {} : identified,
    transcriptWarnings:segments.filter(segment=>segment.transcriptionReview?.annotationsComplete===false).map(segment=>`The window at ${formatMs(segment.startMs)} has incomplete speaker/timing annotations. Do not infer an owner from its neighbouring speaker.`),
    durationMs,
    highlightOffsetsMs: highlights.map((highlight) => highlight.offsetMs),
    knownPeople,
    language: recording.language,
  });

  await patch({
    sealedMemory: sealJson(dek, memory, binding(uid, `recording/${recordingId}`, 'memory')),
    sealedTranscript: sealText(dek, transcript, binding(uid, `recording/${recordingId}`, 'transcript')),
    ...(!recording.sealedSpeakerNames ? {sealedIdentifiedSpeakers:sealJson(dek,identified,binding(uid,`recording/${recordingId}`,'identified-speakers'))} : {}),
  });

  return memory;
}
