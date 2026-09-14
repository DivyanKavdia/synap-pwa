import { openBytes, sealJson, sealText, type Binding } from '../crypto/envelope.js';
import { transcribeSegment } from '../gemini/transcribe.js';
import { parsePcm16Wav } from '../speaker/audio.js';
import * as db from '../store/firestore.js';
import { readSealedSegment } from '../store/gcs.js';
import type { RecordingDoc, SegmentDoc } from '../store/types.js';
import { hasTranscription } from './recording-segments.js';

function binding(uid: string, scope: string, field: string): Binding {
  return { uid, scope, field };
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
  if (hasTranscription(segment)) return segment;

  const completed = await transcribeOne(uid, recordingId, dek, recording, segment);
  return completed;
}

async function transcribeOne(
  uid: string,
  recordingId: string,
  dek: Buffer,
  recording: RecordingDoc,
  segment: SegmentDoc,
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
    language: recording.language,
    diarize: true,
    wordTimestamps: true,
  });

  const completed: SegmentDoc = {
    ...segment,
    state: 'transcribed',
    language: recording.language,
    transcribedAt: new Date().toISOString(),
    transcriptionReview:result.review,
    transcriptionAudioPolicy:'stored-upload-v1',
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

  return db.completeSegmentTranscription(uid, recordingId, completed);
}
