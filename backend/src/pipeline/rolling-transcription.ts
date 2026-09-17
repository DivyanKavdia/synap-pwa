import { openBytes, openText, sealJson, sealText, type Binding } from '../crypto/envelope.js';
import { config } from '../config.js';
import { transcribeSegment } from '../gemini/transcribe.js';
import { parsePcm16Wav } from '../speaker/audio.js';
import * as db from '../store/firestore.js';
import { readSealedSegment } from '../store/gcs.js';
import type { RecordingDoc, SegmentDoc } from '../store/types.js';
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
