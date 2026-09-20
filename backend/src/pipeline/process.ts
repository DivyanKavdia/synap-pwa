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
import { formatMs, longAsrCooldownMs, toSpeakerLines } from '../gemini/transcribe.js';
import { tagSelfSpeaker } from '../speaker/enrich.js';
import { readVoiceProfile } from '../speaker/profile.js';
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
import {
  transcribeUploadedBatch,
  transcribeUploadedWindow,
  hasUsableTranscription,
} from './rolling-transcription.js';
import { requireCompleteSegments, transcriptionBatches } from './recording-segments.js';

const SEGMENT_MS = 30_000;
const ASR_BATCH_MS = config.gemini.transcriptionBatchMinutes * 60_000;

export interface ProcessRecordingOptions {
  /** Reuse sealed segment transcripts only. Missing transcript windows are an error; never call STT. */
  skipTranscription?: boolean;
  /** Refresh memory from retained transcripts and republish derived indexes while preserving human action state. */
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
    {
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
        ? { state: 'ready', progress: 1, errorCode: null, retryable: false, processingLease: null,
            sealedMemory: recording.sealedMemory, sealedTranscript: recording.sealedTranscript,
            sealedIdentifiedSpeakers: recording.sealedIdentifiedSpeakers || null }
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
  const listed = await db.listSegments(uid, recordingId);
  const ordered = requireCompleteSegments(listed, recording.segmentCount || listed.length);
  let done = ordered.filter(segment => hasUsableTranscription(uid, recordingId, dek, segment)).length;
  const batches = transcriptionBatches(
    ordered,
    ASR_BATCH_MS,
    segment => !hasUsableTranscription(uid, recordingId, dek, segment),
  );
  // One budget for the whole call, not one per batch: an hour of audio is three
  // batches, and three four-minute rescues would outlast the worker request.
  const rescueDeadline = Date.now() + COOLDOWN_RESCUE_BUDGET_MS;
  let rescued = 0;
  for (const batch of batches) {
    let completed: SegmentDoc[];
    try {
      completed = await transcribeUploadedBatch(uid, recordingId, batch, dek);
    } catch (cause) {
      const cooldownMs = longAsrCooldownMs(cause);
      if (!cooldownMs) throw cause;
      const pass = await rescueBatchDuringCooldown(
        uid,
        recordingId,
        batch,
        dek,
        cooldownMs,
        rescueDeadline,
        async (finished) => {
          for (const segment of finished) ordered[segment.index] = segment;
          await patch({ progress: 0.05 + 0.5 * ((done + finished.length) / ordered.length) });
        },
      );
      completed = pass.completed;
      rescued += completed.length;
      for (const segment of completed) ordered[segment.index] = segment;
      done += completed.length;
      await patch({ progress: 0.05 + 0.5 * (done / ordered.length) });
      if (completed.length === batch.length) continue;

      const continuation = cooldownContinuation(rescued, pass.failure, cause);
      log.warn('Cooldown rescue transcribed part of a recording', {
        uid,
        recordingId,
        rescued,
        windows: batch.length,
        completed: completed.length,
        retry_after_ms: retryAfterMs(continuation),
        reason: pass.failure === undefined ? 'budget' : 'window_failed',
        stage: 'transcription',
      });
      throw continuation;
    }
    for (const segment of completed) ordered[segment.index] = segment;
    done += completed.length;
    await patch({ progress: 0.05 + 0.5 * (done / ordered.length) });
  }
  return ordered;
}

/** Windows transcribed at once while the dedicated model is blocked. Higher
 * spends the fallback model's per-minute allowance faster than it recovers. */
const COOLDOWN_WINDOW_CONCURRENCY = 3;
/** Total rescue time for one worker delivery. Leaves the request room to finish
 * understanding and indexing; windows past it are durable work for the next
 * delivery, not loss. */
const COOLDOWN_RESCUE_BUDGET_MS = 4 * 60_000;
/** How soon to resume when a delivery ended with windows still outstanding. */
const COOLDOWN_CONTINUE_MS = 15_000;

/** The deadline an error carries, or 0 when it names none. */
function retryAfterMs(error: unknown): number {
  if (error instanceof GeminiError) return Number(error.rateLimit?.retryAfterMs || 0);
  if (error instanceof db.TranscriptionBusyError) return error.retryAfterMs;
  return 0;
}

/**
 * What a rescue that did not finish means for the recording.
 *
 * With nothing salvaged anywhere in this call there is no progress to protect,
 * so the real blockage is reported and its deadline inherited: a twelve-hour
 * quota wait must not be replaced by a fifteen-second one that spends delivery
 * after delivery rediscovering it.
 *
 * With windows already sealed and paid for, failing the recording would throw
 * that work away. A prompt continuation is asked for instead, honouring
 * whatever deadline ended the pass so the next delivery does not arrive early.
 */
export function cooldownContinuation(rescued: number, failure: unknown, cause: unknown): unknown {
  if (!rescued) return failure ?? cause;
  return new db.TranscriptionBusyError(Math.max(COOLDOWN_CONTINUE_MS, retryAfterMs(failure)));
}

/**
 * Transcribe a blocked batch one 30-second window at a time.
 *
 * The long-form batch cannot use the fallback model: that model returns plain
 * text, and word timestamps are the only thing that maps a twenty-minute
 * response back onto Synap's durable 30-second windows. A single window needs
 * no such map — it is already its own boundary — so the per-window path can use
 * the fallback, and the two models hold separate quotas.
 *
 * Every window that completes is sealed and committed on its own. A pass that
 * runs out of budget, or meets a second cooldown, therefore keeps everything it
 * finished. Nothing is ever transcribed twice: the next delivery starts from the
 * windows still missing a usable transcript.
 *
 * Returning rather than throwing is deliberate. What a partial rescue means for
 * the recording depends on what the rest of the call already salvaged, and that
 * is the caller's to decide.
 */
export async function rescueBatchDuringCooldown(
  uid: string,
  recordingId: string,
  batch: SegmentDoc[],
  dek: Buffer,
  cooldownMs: number,
  deadline: number,
  report: (finished: SegmentDoc[]) => Promise<void>,
): Promise<{ completed: SegmentDoc[]; failure?: unknown }> {
  log.warn('Dedicated ASR is in a long cooldown; transcribing windows individually', {
    uid,
    recordingId,
    windows: batch.length,
    retry_after_ms: cooldownMs,
    model: config.gemini.transcribeModel,
    fallback_model: config.gemini.transcribeFallbackModel,
    stage: 'transcription',
  });

  const queue = batch.slice();
  const completed: SegmentDoc[] = [];
  let failure: unknown;
  let reporting: Promise<void> = Promise.resolve();
  let reportedAt = 0;

  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (failure !== undefined || Date.now() >= deadline) return;
      try {
        completed.push(await transcribeUploadedWindow(uid, recordingId, next.index, dek));
      } catch (windowCause) {
        // One failure ends the pass. Whatever stopped this window is waiting for
        // every remaining window too, and paying to rediscover it helps nobody.
        if (failure === undefined) failure = windowCause;
        return;
      }
      // Keep the processing lease warm and the progress bar moving. Serialized
      // and throttled: forty windows must not become forty racing writes to one
      // recording document.
      if (Date.now() - reportedAt < 5_000) continue;
      reportedAt = Date.now();
      const finished = completed.slice();
      reporting = reporting.then(() => report(finished)).catch(() => undefined);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(COOLDOWN_WINDOW_CONCURRENCY, queue.length) }, worker),
  );
  await reporting;
  return { completed, failure };
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
  // A confirmed name is used only for audio that matched the enrolled wearer.
  // Never turn an anonymous/mentioned person into the owner by spelling alone.
  let selfName: string | undefined;
  if (/^\[.*?\] YOU:/m.test(transcript)) {
    try { selfName = (await readVoiceProfile(uid, dek))?.displayName; } catch { /* Keep YOU. */ }
    if (selfName) identified.YOU = selfName;
  }
  const speakerNames = recording.sealedSpeakerNames ? confirmedSpeakers : identified;
  const memory = await extractMemory({
    startedAt: recording.startedAt,
    day: recording.day,
    timezone: recording.timezone,
    transcript: applySpeakerNames(transcript, speakerNames),
    confirmedSpeakers,
    identifiedSpeakers:recording.sealedSpeakerNames ? {} : identified,
    selfSpeakerName: (recording.selfSpeakerLabel ? speakerNames[recording.selfSpeakerLabel] : undefined) || speakerNames.YOU || (!recording.sealedSpeakerNames ? selfName : undefined),
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
