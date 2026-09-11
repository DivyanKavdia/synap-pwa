import { Router } from 'express';
import { openBytes, openJson } from '../../crypto/envelope.js';
import { binding } from '../../pipeline/process.js';
import { materializeTranscript } from '../../pipeline/source-materialize.js';
import { speakerTranscriptFields } from '../../speaker/names.js';
import * as db from '../../store/firestore.js';
import { readSealedSegment } from '../../store/gcs.js';
import type { StructuredMemory } from '../../store/types.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const PCM_BYTES_PER_SECOND = 16_000 * 2; // 16 kHz, mono, signed 16-bit PCM.

export function wavHeader(dataBytes: number, sampleRate = 16_000): Buffer {
  const bytes = Math.max(0, Math.trunc(dataBytes));
  const out = Buffer.alloc(44);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(Math.min(0xffffffff, bytes + 36), 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(Math.min(0xffffffff, bytes), 40);
  return out;
}

/** Extract the PCM data chunk without assuming a fixed 44-byte WAV header. */
export function wavPayload(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Stored source segment is not a PCM WAV file');
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(wav.length, start + size);
    if (id === 'data') return wav.subarray(start, end);
    offset = start + size + (size % 2);
  }
  throw new Error('Stored source WAV has no data chunk');
}

function byteOffset(ms: number): number {
  return Math.max(0, Math.round((Number(ms) || 0) * PCM_BYTES_PER_SECOND / 1000));
}

/**
 * Source routes deliberately use route-scoped auth so they can be mounted ahead
 * of recordingRoutes(), whose blanket middleware would otherwise intercept
 * them. Both endpoints reconstruct from durable evidence rather than trusting a
 * potentially stale browser cache.
 */
export function sourceRoutes(): Router {
  const router = Router();

  router.get(
    '/recordings/:recordingId/source',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const recordingId = String(req.params.recordingId);
      const recording = await db.getRecording(req.uid, recordingId);
      if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');

      const transcript = await materializeTranscript(req.uid, recording, req.dek);
      let memory: StructuredMemory | null = null;
      if (recording.sealedMemory) {
        try {
          memory = openJson<StructuredMemory>(
            req.dek,
            recording.sealedMemory,
            binding(req.uid, `recording/${recordingId}`, 'memory'),
          );
        } catch {
          memory = null;
        }
      }

      res.status(200).json({
        recording_id: recordingId,
        day: recording.day,
        started_at: recording.startedAt,
        ended_at: recording.endedAt,
        duration_ms: recording.durationMs,
        state: recording.state,
        progress: recording.progress,
        retryable: recording.retryable,
        error_code: recording.errorCode,
        ...(memory ?? {}),
        transcript: transcript.text,
        ...speakerTranscriptFields(req.uid, recording, req.dek, transcript.originalText),
        transcript_source: transcript.source,
        transcript_segments: transcript.transcriptSegments,
        segment_count: transcript.segmentCount,
        transcript_complete: transcript.complete,
      });
    }),
  );

  router.get(
    '/recordings/:recordingId/audio',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const recordingId = String(req.params.recordingId);
      const recording = await db.getRecording(req.uid, recordingId);
      if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');

      const segments = (await db.listSegments(req.uid, recordingId))
        .filter((segment) => Boolean(segment.storagePath))
        .sort((a, b) => a.index - b.index);
      if (segments.length === 0) {
        throw new HttpError(410, 'audio_unavailable', 'No retained source audio is available for this recording');
      }

      const targetBytes = Math.max(
        byteOffset(recording.durationMs),
        ...segments.map((segment) => byteOffset(segment.endMs)),
      );
      const chunks: Buffer[] = [];
      let cursor = 0;
      let retained = 0;
      let unavailable = 0;

      for (const segment of segments) {
        const start = byteOffset(segment.startMs);
        const end = Math.max(start, byteOffset(segment.endMs));
        if (start > cursor) chunks.push(Buffer.alloc(start - cursor));
        cursor = Math.max(cursor, start);

        const sealed = segment.storagePath ? await readSealedSegment(segment.storagePath) : null;
        if (!sealed) {
          unavailable += 1;
          if (end > cursor) chunks.push(Buffer.alloc(end - cursor));
          cursor = Math.max(cursor, end);
          continue;
        }

        const wav = openBytes(
          req.dek,
          sealed,
          binding(req.uid, `recording/${recordingId}/segment/${segment.index}`, 'audio'),
        );
        let pcm = wavPayload(wav);
        const expected = Math.max(0, end - start);
        if (expected && pcm.length > expected) pcm = pcm.subarray(0, expected);
        if (cursor > start) pcm = pcm.subarray(Math.min(pcm.length, cursor - start));
        if (pcm.length) {
          chunks.push(pcm);
          cursor += pcm.length;
          retained += 1;
        }
        if (end > cursor) {
          chunks.push(Buffer.alloc(end - cursor));
          cursor = end;
        }
      }

      if (retained === 0) {
        throw new HttpError(410, 'audio_expired', 'The retained cloud source audio has expired for this recording');
      }
      if (targetBytes > cursor) chunks.push(Buffer.alloc(targetBytes - cursor));

      const dataBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const body = Buffer.concat([wavHeader(dataBytes, recording.sampleRate || 16_000), ...chunks]);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', String(body.length));
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Synap-Audio-Segments', String(retained));
      res.setHeader('X-Synap-Audio-Gaps', String(unavailable));
      res.status(200).send(body);
    }),
  );

  return router;
}
