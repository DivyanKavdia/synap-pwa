import { Router, raw } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { openJson, sealBytes } from '../../crypto/envelope.js';
import { enqueueProcessing } from '../../pipeline/queue.js';
import { binding } from '../../pipeline/process.js';
import * as db from '../../store/firestore.js';
import { segmentPath, writeSealedSegment } from '../../store/gcs.js';
import type { HighlightDoc, RecordingDoc, SegmentDoc, StructuredMemory } from '../../store/types.js';
import { fingerprint, localDay, sha256 } from '../../util/ids.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const createBody = z.object({
  recording_id: z.string().uuid(),
  device_id: z.string().max(64).default(''),
  started_at: z.string().datetime(),
  sample_rate: z.number().int().positive().default(16000),
  channels: z.number().int().positive().max(2).default(1),
  encoding: z.string().default('pcm_s16le'),
  language: z.string().default('auto'),
  timezone: z.string().default('Asia/Kolkata'),
  continuous_group_id: z.string().uuid().nullable().default(null),
  continuous_part: z.number().int().positive().default(1),
});

const finalizeBody = z.object({
  ended_at: z.string().datetime(),
  duration_ms: z.number().int().nonnegative(),
  segment_count: z.number().int().nonnegative(),
});

const highlightBody = z.object({
  highlight_id: z.string().uuid(),
  offset_ms: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  source: z.enum(['pwa', 'pendant']).default('pendant'),
  note: z.string().max(2000).nullable().default(null),
});

/** Every mutating call must carry an Idempotency-Key; retries are guaranteed. */
function idempotencyKey(req: AuthedRequest): string {
  const key = req.header('idempotency-key');
  if (!key || key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  }
  return key;
}

export function recordingRoutes(): Router {
  const router = Router();
  router.use(requireAuth());

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------
  router.post(
    '/recordings',
    handler<AuthedRequest>(async (req, res) => {
      const body = createBody.safeParse(req.body);
      if (!body.success) {
        throw new HttpError(400, 'bad_request', body.error.issues[0]?.message ?? 'Invalid body');
      }
      // No Idempotency-Key here on purpose. This endpoint is idempotent on
      // recording_id: an existing recording is returned rather than duplicated.
      // A ledger keyed on the body could only ever reject a legitimate retry.
      const input = body.data;
      const now = new Date().toISOString();
      const existing = await db.getRecording(req.uid, input.recording_id);

      const doc: RecordingDoc = existing ?? {
        recordingId: input.recording_id,
        deviceId: input.device_id,
        startedAt: input.started_at,
        endedAt: null,
        durationMs: 0,
        sampleRate: input.sample_rate,
        channels: input.channels,
        encoding: input.encoding,
        language: input.language,
        day: localDay(input.started_at, input.timezone),
        timezone: input.timezone,
        continuousGroupId: input.continuous_group_id,
        continuousPart: input.continuous_part,
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

      await db.putRecording(req.uid, doc);
      res.status(existing ? 200 : 201).json({
        recording_id: doc.recordingId,
        state: doc.state,
        day: doc.day,
        uploaded_segments: doc.uploadedSegments,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Segment upload
  // -------------------------------------------------------------------------
  router.put(
    '/recordings/:recordingId/segments/:index',
    raw({ type: ['audio/wav', 'application/octet-stream'], limit: config.limits.maxSegmentBytes }),
    handler<AuthedRequest>(async (req, res) => {
      const recordingId = String(req.params.recordingId);
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) {
        throw new HttpError(400, 'bad_request', 'Segment index must be a non-negative integer');
      }

      const recording = await db.getRecording(req.uid, recordingId);
      if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');

      const audio = req.body as Buffer;
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        throw new HttpError(400, 'empty_body', 'Segment body must be audio bytes');
      }

      const digest = sha256(audio);
      const declared = req.header('x-synap-sha256');
      // The client computes the digest before upload; a mismatch means the
      // bytes changed in flight and must not be transcribed.
      if (declared && declared.toLowerCase() !== digest) {
        throw new HttpError(400, 'digest_mismatch', 'Segment SHA-256 does not match the body');
      }

      const existing = await db.getSegment(req.uid, recordingId, index);
      if (existing?.sha256 === digest && existing.storagePath) {
        // Exactly the idempotent replay the spec requires.
        res.status(200).json({ segment_index: index, state: existing.state, sha256: digest });
        return;
      }

      const startMs = Number(req.header('x-synap-start-ms') ?? index * 30_000);
      const endMs = Number(req.header('x-synap-end-ms') ?? startMs + 30_000);

      const path = segmentPath(req.uid, recordingId, index);
      const sealed = sealBytes(
        req.dek,
        audio,
        binding(req.uid, `recording/${recordingId}/segment/${index}`, 'audio'),
      );
      await writeSealedSegment(path, sealed, {
        uid: req.uid,
        recordingId,
        index: String(index),
        sha256: digest,
      });

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
      await db.putSegment(req.uid, recordingId, doc);

      const uploaded = await db.countSegments(req.uid, recordingId);
      await db.patchRecording(req.uid, recordingId, {
        state: recording.state === 'created' ? 'uploading' : recording.state,
        uploadedSegments: uploaded,
      });

      res.status(200).json({ segment_index: index, state: 'accepted', sha256: digest });
    }),
  );

  // -------------------------------------------------------------------------
  // Highlights
  // -------------------------------------------------------------------------
  router.post(
    '/recordings/:recordingId/highlights',
    handler<AuthedRequest>(async (req, res) => {
      const recordingId = String(req.params.recordingId);
      const body = highlightBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'Invalid highlight');

      const recording = await db.getRecording(req.uid, recordingId);
      if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');

      const doc: HighlightDoc = {
        highlightId: body.data.highlight_id,
        offsetMs: body.data.offset_ms,
        createdAt: body.data.created_at,
        source: body.data.source,
        sealedNote: body.data.note
          ? sealBytes(
              req.dek,
              Buffer.from(body.data.note, 'utf8'),
              binding(req.uid, `highlight/${body.data.highlight_id}`, 'note'),
            )
          : null,
      };
      await db.putHighlight(req.uid, recordingId, doc);
      res.status(201).json({ highlight_id: doc.highlightId, offset_ms: doc.offsetMs });
    }),
  );

  // -------------------------------------------------------------------------
  // Finalize
  // -------------------------------------------------------------------------
  router.post(
    '/recordings/:recordingId/finalize',
    handler<AuthedRequest>(async (req, res) => {
      const recordingId = String(req.params.recordingId);
      const body = finalizeBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'Invalid finalize body');

      const key = idempotencyKey(req);
      const claim = await db.claimIdempotencyKey(
        req.uid,
        key,
        fingerprint({ recordingId, ...body.data }),
      );
      if (!claim.fresh && claim.response) {
        res.status(202).json(claim.response);
        return;
      }

      const recording = await db.getRecording(req.uid, recordingId);
      if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');

      const uploaded = await db.countSegments(req.uid, recordingId);
      if (uploaded === 0) {
        throw new HttpError(409, 'no_segments', 'No audio segments were uploaded', false);
      }

      await db.patchRecording(req.uid, recordingId, {
        endedAt: body.data.ended_at,
        durationMs: body.data.duration_ms,
        segmentCount: body.data.segment_count,
        uploadedSegments: uploaded,
        state: 'uploaded',
        progress: 0,
      });

      await enqueueProcessing(req.uid, recordingId);

      const response = {
        recording_id: recordingId,
        state: 'uploaded',
        uploaded_segments: uploaded,
        // A gap here means segments are still in flight; the PWA retries them
        // and finalize is idempotent, so this is informational, not an error.
        missing_segments: Math.max(0, body.data.segment_count - uploaded),
      };
      await db.completeIdempotencyKey(req.uid, key, response);
      res.status(202).json(response);
    }),
  );

  // -------------------------------------------------------------------------
  // Processing status and memory
  // -------------------------------------------------------------------------
  router.get(
    '/recordings/:recordingId/processing',
    handler<AuthedRequest>(async (req, res) => {
      const recording = await db.getRecording(req.uid, String(req.params.recordingId));
      if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');
      res.status(200).json({
        state: recording.state,
        progress: recording.progress,
        retryable: recording.retryable,
        error_code: recording.errorCode,
        uploaded_segments: recording.uploadedSegments,
      });
    }),
  );

  router.get(
    '/recordings/:recordingId/memory',
    handler<AuthedRequest>(async (req, res) => {
      const recordingId = String(req.params.recordingId);
      const recording = await db.getRecording(req.uid, recordingId);
      if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');
      if (!recording.sealedMemory) {
        throw new HttpError(409, 'not_ready', `Recording is ${recording.state}`, true);
      }

      const memory = openJson<StructuredMemory>(
        req.dek,
        recording.sealedMemory,
        binding(req.uid, `recording/${recordingId}`, 'memory'),
      );
      res.status(200).json({
        recording_id: recordingId,
        day: recording.day,
        started_at: recording.startedAt,
        duration_ms: recording.durationMs,
        ...memory,
      });
    }),
  );

  router.delete(
    '/recordings/:recordingId',
    handler<AuthedRequest>(async (req, res) => {
      const recordingId = String(req.params.recordingId);
      const { deleteRecordingAudio } = await import('../../store/gcs.js');
      await deleteRecordingAudio(req.uid, recordingId);
      await db.deleteRecording(req.uid, recordingId);
      res.status(204).end();
    }),
  );

  return router;
}
