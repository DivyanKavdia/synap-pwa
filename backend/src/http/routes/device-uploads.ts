import { Router, raw } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { sealBytes } from '../../crypto/envelope.js';
import { enqueueProcessing } from '../../pipeline/queue.js';
import { binding } from '../../pipeline/process.js';
import { parsePcm16Wav } from '../../speaker/audio.js';
import * as db from '../../store/firestore.js';
import { deleteSegment, segmentPath, writeSealedSegment } from '../../store/gcs.js';
import type { RecordingDoc, SegmentDoc } from '../../store/types.js';
import { localDay, sha256 } from '../../util/ids.js';
import {
  issueDeviceUploadToken,
  requireAuth,
  requireDeviceUpload,
  type AuthedRequest,
  type DeviceUploadRequest,
} from '../auth.js';
import { HttpError, handler } from '../errors.js';

const beginBody = z.object({
  recording_id: z.string().uuid(),
  device_id: z.string().min(1).max(64),
  started_at: z.string().datetime(),
  language: z.string().default('auto'),
  timezone: z.string().default('Asia/Kolkata'),
});

const finalizeBody = z.object({
  ended_at: z.string().datetime(),
  duration_ms: z.number().int().nonnegative(),
  segment_count: z.number().int().positive().safe(),
});

async function discardUnused(path: string): Promise<void> {
  try { await deleteSegment(path); } catch { /* retention collects orphaned attempts */ }
}

export function deviceUploadRoutes(): Router {
  const router = Router();

  router.post('/device-uploads', requireAuth(), handler<AuthedRequest>(async (req, res) => {
    const parsed = beginBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid device upload request');
    const input = parsed.data;
    const now = new Date().toISOString();
    const proposed: RecordingDoc = {
      recordingId: input.recording_id,
      deviceId: input.device_id,
      startedAt: input.started_at,
      endedAt: null,
      durationMs: 0,
      sampleRate: 16000,
      channels: 1,
      encoding: 'pcm_s16le',
      language: input.language,
      day: localDay(input.started_at, input.timezone),
      timezone: input.timezone,
      continuousGroupId: null,
      continuousPart: 1,
      segmentCount: 0,
      uploadedSegments: 0,
      state: 'created',
      progress: 0,
      errorCode: null,
      retryable: false,
      sealedMemory: null,
      sealedTranscript: null,
      createdAt: now,
      updatedAt: now,
    };
    const { doc } = await db.createRecording(req.uid, proposed);
    if (doc.deviceId && doc.deviceId !== input.device_id) {
      throw new HttpError(409, 'device_mismatch', 'Recording belongs to a different device');
    }
    const ticket = await issueDeviceUploadToken(req.user, doc.recordingId, input.device_id);
    res.status(201).json({
      recording_id: doc.recordingId,
      upload_token: ticket.token,
      expires_in: ticket.expires_in,
      segment_ms: 30000,
    });
  }));

  router.get(
    '/device-uploads/:recordingId/status',
    requireDeviceUpload(),
    handler<DeviceUploadRequest>(async (req, res) => {
      const recording = await db.getRecording(req.uid, req.uploadRecordingId);
      if (!recording || recording.deleting || (recording.deviceId && recording.deviceId !== req.uploadDeviceId)) {
        throw new HttpError(404, 'not_found', 'Unknown device upload');
      }
      const segments = await db.listSegments(req.uid, req.uploadRecordingId);
      const indexes = new Set(segments.map(segment => segment.index));
      let next = 0;
      while (indexes.has(next)) next++;
      res.status(200).json({
        recording_id: req.uploadRecordingId,
        uploaded_segments: segments.length,
        next_segment: next,
        finalized: Boolean(recording.endedAt),
      });
    }),
  );

  router.put(
    '/device-uploads/:recordingId/segments/:index',
    requireDeviceUpload(),
    raw({ type: ['audio/wav', 'application/octet-stream'], limit: config.limits.maxSegmentBytes }),
    handler<DeviceUploadRequest>(async (req, res) => {
      const index = Number(req.params.index);
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new HttpError(400, 'bad_request', 'Invalid segment index');
      }
      const recording = await db.getRecording(req.uid, req.uploadRecordingId);
      if (!recording || recording.deleting || (recording.deviceId && recording.deviceId !== req.uploadDeviceId)) {
        throw new HttpError(404, 'not_found', 'Unknown device upload');
      }
      const audio = req.body as Buffer;
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        throw new HttpError(400, 'empty_body', 'Segment body is required');
      }
      try { parsePcm16Wav(audio); }
      catch {
        throw new HttpError(400, 'invalid_audio', 'Device segment must be complete mono 16-bit PCM WAV at 16 kHz');
      }
      const digest = sha256(audio);
      const declared = req.header('x-synap-sha256');
      if (declared && declared.toLowerCase() !== digest) {
        throw new HttpError(400, 'digest_mismatch', 'Segment digest mismatch');
      }
      const startMs = Number(req.header('x-synap-start-ms') ?? index * 30000);
      const endMs = Number(req.header('x-synap-end-ms') ?? startMs + 30000);
      if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) {
        throw new HttpError(400, 'bad_segment_timing', 'Invalid segment timing');
      }
      const existing = await db.getSegment(req.uid, req.uploadRecordingId, index);
      const source = { index, sha256: digest, bytes: audio.length, startMs, endMs };
      if (existing && !db.sameSegmentSource(existing, source)) {
        throw new HttpError(409, 'segment_conflict', 'Segment conflicts with already accepted audio');
      }
      if (existing?.storagePath) {
        res.status(200).json({ segment_index: index, state: existing.state, sha256: digest });
        return;
      }
      const path = segmentPath(req.uid, req.uploadRecordingId, index);
      const scope = 'recording/' + req.uploadRecordingId + '/segment/' + index;
      await writeSealedSegment(
        path,
        sealBytes(req.dek, audio, binding(req.uid, scope, 'audio')),
        { uid: req.uid, recordingId: req.uploadRecordingId, index: String(index), sha256: digest },
      );
      const doc: SegmentDoc = {
        index,
        startMs,
        endMs,
        sha256: digest,
        bytes: audio.length,
        storagePath: path,
        state: 'accepted',
        sealedTranscript: null,
        sealedWords: null,
        language: null,
        uploadedAt: new Date().toISOString(),
        transcribedAt: null,
      };
      try {
        const accepted = await db.acceptSegment(req.uid, req.uploadRecordingId, doc, recording.createdAt);
        if (accepted.storagePath !== path) await discardUnused(path);
      } catch (cause) {
        if (cause instanceof db.SegmentWriteError) await discardUnused(path);
        throw cause;
      }
      res.status(202).json({ segment_index: index, state: 'accepted', sha256: digest });
    }),
  );

  router.post(
    '/device-uploads/:recordingId/finalize',
    requireDeviceUpload(),
    handler<DeviceUploadRequest>(async (req, res) => {
      const parsed = finalizeBody.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid finalize body');
      let recording: RecordingDoc;
      try {
        recording = await db.finalizeRecording(req.uid, req.uploadRecordingId, {
          endedAt: parsed.data.ended_at,
          durationMs: parsed.data.duration_ms,
          segmentCount: parsed.data.segment_count,
        });
      } catch (cause) {
        if (cause instanceof db.SegmentWriteError && cause.retryable) {
          throw new HttpError(409, 'incomplete_upload', cause.message, true);
        }
        throw cause;
      }
      await enqueueProcessing(req.uid, req.uploadRecordingId, 'device-upload');
      res.status(202).json({
        recording_id: req.uploadRecordingId,
        state: recording.state,
        uploaded_segments: recording.uploadedSegments,
        complete: recording.uploadedSegments === parsed.data.segment_count,
      });
    }),
  );

  return router;
}
