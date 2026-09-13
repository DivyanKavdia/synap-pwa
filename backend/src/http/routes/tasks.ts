/**
 * Worker and processing-recovery endpoints.
 *
 * Cloud Tasks is the normal background path. It calls /tasks/process with an
 * OIDC token minted for our own service account. A signed-in PWA may also call
 * /recordings/:recordingId/process-now when processing stops advancing. The
 * recovery path is deliberately narrow: it can only process a recording owned
 * by the authenticated user, and a fresh active worker is always left alone.
 *
 * A force=true query is reserved for refreshing an already-ready memory from
 * its sealed 30-second transcript windows. Force rebuilds never call STT and
 * never rewrite the people/follow-up/retrieval indexes; they refresh the
 * recording memory + day brief only.
 */

import { Router } from 'express';
import { z } from 'zod';
import { processRecording, processingFailure } from '../../pipeline/process.js';
import * as db from '../../store/firestore.js';
import type { RecordingDoc } from '../../store/types.js';
import { log } from '../../util/log.js';
import { requireAuth, requireTaskAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const taskBody = z.object({
  uid: z.string().min(1),
  recordingId: z.string().min(1),
});

const ACTIVE_STATES = new Set(['transcribing', 'understanding', 'indexing']);
/** Active stages update progress as work advances. Ten quiet minutes is long
 * enough to avoid racing a slow model call, while still recovering a worker
 * that died after persisting an active state. */
const ACTIVE_STALE_MS = db.PROCESSING_STALE_MS;

export function isStaleActiveRecording(recording: RecordingDoc, now = Date.now()): boolean {
  if (!ACTIVE_STATES.has(recording.state)) return false;
  const updatedAt = Date.parse(recording.updatedAt);
  return !Number.isFinite(updatedAt) || now - updatedAt >= ACTIVE_STALE_MS;
}

export function taskRoutes(): Router {
  const router = Router();

  router.post(
    '/tasks/process',
    requireTaskAuth(),
    handler(async (req, res) => {
      const body = taskBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'uid and recordingId are required');

      const { uid, recordingId } = body.data;
      try {
        const existing = await db.getRecording(uid, recordingId);
        if (!existing || existing.deleting || (existing.state === 'failed' && !existing.retryable)) {
          res.status(200).json({ state: 'failed', error: { code: 'permanent', retryable: false } });
          return;
        }
        await processRecording(uid, recordingId);
        res.status(200).json({ state: 'ready' });
      } catch (cause) {
        const { message, retryable } = processingFailure(cause);
        // Cloud Tasks retries every non-2xx. A permanent failure is acknowledged
        // only after its durable state is visible (or the recording is gone).
        // If saving the failure itself failed, retain the task for recovery.
        const current = !retryable ? await db.getRecording(uid, recordingId) : null;
        const permanent = !retryable && (!current || current.deleting || current.state === 'ready' ||
          (current.state === 'failed' && !current.retryable));
        log.error('Task processing failed', { uid, recordingId, permanent, error: message });
        res.status(permanent ? 200 : 500).json({
          state: permanent ? 'failed' : 'retrying',
          error: { code: permanent ? 'permanent' : 'transient', message, retryable: !permanent },
        });
      }
    }),
  );

  router.post(
    '/recordings/:recordingId/process-now',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const recordingId = String(req.params.recordingId);
      const recording = await db.getRecording(req.uid, recordingId);
      if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');
      const force = String(req.query.force ?? '') === 'true';
      const rebuild = recording.state === 'ready' && force;
      let rebuildSegmentCount = 0;

      if (recording.state === 'ready' && !force) {
        res.status(200).json({ recording_id: recordingId, state: 'ready', recovered: false });
        return;
      }

      // A fresh active state means Cloud Tasks is doing useful work. A stale
      // active state is different: the worker may have died after persisting its
      // stage. processRecording is restart-safe and skips sealed transcripts, so
      // let the transaction claim it and resume from durable evidence.
      if (ACTIVE_STATES.has(recording.state)) {
        if (!isStaleActiveRecording(recording)) {
          res.status(202).json({ recording_id: recordingId, state: recording.state, recovered: false });
          return;
        }
        log.warn('Recovering stale active processing state', {
          uid: req.uid,
          recordingId,
          state: recording.state,
          updatedAt: recording.updatedAt,
        });

      }

      if (rebuild) {
        const segments = await db.listSegments(req.uid, recordingId);
        if (segments.length === 0) {
          throw new HttpError(409, 'no_segments', 'No sealed transcript windows are available to rebuild this memory');
        }
        const missing = segments.filter((segment) => !segment.sealedTranscript);
        if (missing.length > 0) {
          // Do not silently turn a cheap semantic repair into a paid audio
          // transcription pass. The existing ready memory stays untouched.
          throw new HttpError(
            409,
            'transcript_windows_incomplete',
            `Rebuild aborted without retranscribing: ${missing.length} transcript window(s) are missing`,
            false,
          );
        }
        rebuildSegmentCount = segments.length;

        log.warn('Refreshing ready memory from sealed transcript windows only', {
          uid: req.uid,
          recordingId,
          segments: rebuildSegmentCount,
        });
      } else {
        if (recording.state === 'failed' && !recording.retryable) {
          throw new HttpError(409, 'not_retryable', recording.errorCode || 'Processing cannot be retried');
        }
        if (recording.state !== 'uploaded' && recording.state !== 'failed' && !isStaleActiveRecording(recording)) {
          throw new HttpError(409, 'not_ready', `Recording is ${recording.state}`);
        }
        log.warn('Using authenticated processing recovery', { uid: req.uid, recordingId, state: recording.state });
      }

      await processRecording(
        req.uid,
        recordingId,
        rebuild ? { skipTranscription: true, memoryOnly: true } : {},
      );

      const updated = await db.getRecording(req.uid, recordingId);
      const state = updated?.state ?? 'ready';
      res.status(state === 'ready' ? 200 : 202).json({
        recording_id: recordingId,
        state,
        recovered: true,
        rebuilt: rebuild,
        ...(rebuild ? { reused_transcript_segments: rebuildSegmentCount, retranscribed_segments: 0 } : {}),
      });
    }),
  );

  return router;
}
