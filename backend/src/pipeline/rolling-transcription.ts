import { openBytes, openText, sealJson, sealText, type Binding } from '../crypto/envelope.js';
import { config } from '../config.js';
import { formatMs, transcribeSegment } from '../gemini/transcribe.js';
import { makePcm16Wav, parsePcm16Wav } from '../speaker/audio.js';
import * as db from '../store/firestore.js';
import { readSealedSegment } from '../store/gcs.js';
import type { RecordingDoc, SegmentDoc, TranscriptWord } from '../store/types.js';
import { hasTranscription } from './recording-segments.js';
import { newId } from '../util/ids.js';
import { GeminiError } from '../gemini/client.js';
import { log } from '../util/log.js';
import { readVoiceProfile } from '../speaker/profile.js';
import { readKnownSpeakers } from '../speaker/known.js';
import { speakerServiceConfigured } from '../speaker/client.js';

/** Speaker timing has an extra ASR cost. Enable it only for opted-in accounts. */
export async function needsSpeakerAnnotations(uid: string, dek: Buffer): Promise<boolean> {
  if (!speakerServiceConfigured()) return false;
  try {
    return Boolean(await readVoiceProfile(uid, dek)) || (await readKnownSpeakers(uid, dek)).length > 0;
  } catch {
    log.warn('Voice settings unavailable; retaining ordinary transcription');
    return false;
  }
}

function binding(uid: string, scope: string, field: string): Binding {
  return { uid, scope, field };
}

/** Older empty results need a real ASR retry; valid existing words stay intact. */
export function hasUsableTranscription(uid: string, recordingId: string, dek: Buffer, segment: SegmentDoc): boolean {
  if (!hasTranscription(segment)) return false;
  if (segment.transcriptionReview?.policy === 'text-first-v1') return true;
  return Boolean(openText(dek, segment.sealedTranscript!,
    binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'transcript')).trim());
}

/**
 * Transcribe one already-uploaded 30-second processing window immediately.
 * This is safe to call repeatedly: a segment with sealed transcript + words is
 * returned without another model call, so PUT retries remain idempotent.
 */
export async function transcribeUploadedWindow(
  uid: string,
  recordingId: string,
  segmentIndex: number,
  dek: Buffer,
): Promise<SegmentDoc> {
  const recording = await db.getRecording(uid, recordingId);
  if (!recording || recording.deleting) throw new db.SegmentWriteError(404, 'Unknown recording');

  const segment = await db.getSegment(uid, recordingId, segmentIndex);
  if (!segment) throw new db.SegmentWriteError(404, 'Unknown segment');
  if (hasUsableTranscription(uid, recordingId, dek, segment)) return segment;

  const lease = newId();
  const claim = await db.claimSegmentTranscription(uid, recordingId, segment, lease);
  if (!claim.claimed) return claim.segment;
  const signal = AbortSignal.timeout(90_000);
  let release = true;
  try {
    const completed = await transcribeOne(uid, recordingId, dek, recording, claim.segment, lease, signal);
    release = false; // The completion transaction already cleared the lease.
    return completed;
  } catch (cause) {
    // An ambiguous timeout may still be executing at the provider. Hold the
    // short lease until expiry instead of immediately paying for another call.
    if (signal.aborted || (cause instanceof GeminiError && cause.status === 0 && cause.reason === 'request')) release = false;
    throw cause;
  } finally {
    if (release) await db.releaseSegmentTranscription(uid, recordingId, segment.index, lease)
      .catch(() => log.warn('Transcription lease will recover at expiry'));
  }
}

const BATCH_TRANSCRIPTION_LEASE_MS = 6 * 60_000;

/**
 * Transcribe a contiguous set of durable 30-second source windows as one Gemini
 * request, then project timestamped words back onto the original windows.
 *
 * Storage/recovery granularity stays small while provider request granularity
 * follows Gemini 3.5 Transcribe's long-form file-processing model.
 */
export async function transcribeUploadedBatch(
  uid: string,
  recordingId: string,
  sources: SegmentDoc[],
  dek: Buffer,
): Promise<SegmentDoc[]> {
  if (!sources.length) return [];
  const recording = await db.getRecording(uid, recordingId);
  if (!recording || recording.deleting) throw new db.SegmentWriteError(404, 'Unknown recording');

  const ordered = sources.slice().sort((a, b) => a.index - b.index);
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i]!.index !== ordered[i - 1]!.index + 1)
      throw new db.SegmentWriteError(409, 'Transcription batch must contain contiguous audio windows', true);

  const lease = newId();
  const claimed: SegmentDoc[] = [];
  let ambiguous = false;
  let batchSignal: AbortSignal | undefined;
  try {
    // Claim every source before the paid request. Existing legacy clients may
    // still ask for one rolling window directly; per-window leases fence that
    // path from this batch worker.
    for (const source of ordered) {
      const claim = await db.claimSegmentTranscription(
        uid,
        recordingId,
        source,
        lease,
        Date.now(),
        BATCH_TRANSCRIPTION_LEASE_MS,
      );
      if (!claim.claimed) {
        if (hasUsableTranscription(uid, recordingId, dek, claim.segment))
          throw new db.TranscriptionBusyError(1_000);
        throw new db.TranscriptionBusyError(BATCH_TRANSCRIPTION_LEASE_MS);
      }
      claimed.push(claim.segment);
    }

    const pcm: Buffer[] = [];
    for (const segment of claimed) {
      const sealed = segment.storagePath ? await readSealedSegment(segment.storagePath) : null;
      if (!sealed) throw new Error(`Segment audio missing for ${segment.index}`);
      const audio = openBytes(
        dek,
        sealed,
        binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'audio'),
      );
      let parsed;
      try { parsed = parsePcm16Wav(audio); }
      catch { throw new db.SegmentWriteError(409, 'Stored audio is malformed. Keep the original for recovery.'); }
      pcm.push(parsed.data);
    }

    const batchAudio = makePcm16Wav(Buffer.concat(pcm));
    const annotateSpeakers = await needsSpeakerAnnotations(uid, dek);
    batchSignal = AbortSignal.timeout(300_000);
    const result = await transcribeSegment(batchAudio, 'audio/wav', {
      baseOffsetMs: claimed[0]!.startMs,
      speed: config.gemini.transcriptionSpeed,
      language: recording.language,
      diarize: annotateSpeakers,
      wordTimestamps: true,
      primaryWordTimestamps: true,
      primaryDiarization: annotateSpeakers,
      useFileApi: true,
      enrichAnnotations: false,
      signal: batchSignal,
    });
    ambiguous = batchSignal.aborted;

    const wordsBySegment = new Map<number, TranscriptWord[]>();
    for (const segment of claimed) wordsBySegment.set(segment.index, []);
    for (const word of result.words) {
      const point = (word.start_ms + word.end_ms) / 2;
      const owner = claimed.find((segment, index) =>
        point < segment.endMs || index === claimed.length - 1,
      );
      if (owner) wordsBySegment.get(owner.index)!.push(word);
    }

    if (result.review.outcome === 'speech' && result.words.length === 0)
      throw new GeminiError(
        'Long transcription batch returned no usable word timestamps.',
        0,
        true,
        'incomplete',
        undefined,
        { model: config.gemini.transcribeModel, stage: 'transcription' },
      );

    const completed: SegmentDoc[] = [];
    for (let i = 0; i < claimed.length; i++) {
      const segment = claimed[i]!;
      const words = wordsBySegment.get(segment.index) || [];
      const text = words.map(word => word.text).join(' ').trim();
      const outcome = result.review.outcome === 'digital-silence'
        ? 'digital-silence'
        : text ? 'speech' : 'no-speech';
      const doc: SegmentDoc = {
        ...segment,
        state: 'transcribed',
        language: recording.language,
        transcribedAt: new Date().toISOString(),
        transcriptionReview: {
          attempted: result.review.attempted,
          annotationsComplete: true,
          policy: 'text-first-v1',
          outcome,
        },
        transcriptionAudioPolicy: result.audioUsage?.policy || 'stored-upload-v1',
        ...(i === 0 && result.audioUsage ? { transcriptionAudioUsage: result.audioUsage } : {}),
        sealedTranscript: sealText(
          dek,
          text ? `[${formatMs(segment.startMs)}] S?: ${text}` : '',
          binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'transcript'),
        ),
        sealedWords: sealJson(
          dek,
          words,
          binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'words'),
        ),
      };
      completed.push(await db.completeSegmentTranscription(
        uid,
        recordingId,
        doc,
        segment.sealedTranscript,
        lease,
      ));
    }
    return completed;
  } catch (cause) {
    ambiguous ||= Boolean(batchSignal?.aborted) ||
      (cause instanceof GeminiError && cause.status === 0 && cause.reason === 'request');
    throw cause;
  } finally {
    // A lost provider response may still be running/billed. Preserve those
    // leases until expiry; all other failures can release immediately.
    if (!ambiguous)
      await Promise.all(claimed.map(segment =>
        db.releaseSegmentTranscription(uid, recordingId, segment.index, lease)
          .catch(() => undefined),
      ));
  }
}

async function transcribeOne(
  uid: string,
  recordingId: string,
  dek: Buffer,
  recording: RecordingDoc,
  segment: SegmentDoc,
  lease: string,
  signal: AbortSignal,
): Promise<SegmentDoc> {
  const sealed = segment.storagePath ? await readSealedSegment(segment.storagePath) : null;
  if (!sealed) throw new Error(`Segment audio missing for ${segment.index}`);

  const audio = openBytes(
    dek,
    sealed,
    binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'audio'),
  );
  try {
    parsePcm16Wav(audio);
  } catch {
    throw new db.SegmentWriteError(409, 'Stored audio is malformed. Keep the original for recovery.');
  }

  const result = await transcribeSegment(audio, 'audio/wav', {
    baseOffsetMs: segment.startMs,
    speed: config.gemini.transcriptionSpeed,
    language: recording.language,
    diarize: true,
    wordTimestamps: true,
    enrichAnnotations: await needsSpeakerAnnotations(uid, dek),
    signal,
  });

  const completed: SegmentDoc = {
    ...segment,
    state: 'transcribed',
    language: recording.language,
    transcribedAt: new Date().toISOString(),
    transcriptionReview:result.review,
    transcriptionAudioPolicy: result.audioUsage?.policy || 'stored-upload-v1',
    transcriptionAudioUsage: result.audioUsage,
    sealedTranscript: sealText(
      dek,
      result.text,
      binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'transcript'),
    ),
    sealedWords: sealJson(
      dek,
      result.words,
      binding(uid, `recording/${recordingId}/segment/${segment.index}`, 'words'),
    ),
  };

  return db.completeSegmentTranscription(uid, recordingId, completed, segment.sealedTranscript, lease);
}
