/**
 * Worker and processing-recovery endpoints.
 *
 * Cloud Tasks is the normal background path. It calls /tasks/process with an
 * OIDC token minted for our own service account. A signed-in PWA may also call
 * /recordings/:recordingId/process-now when an uploaded recording has not been
 * picked up by Cloud Tasks. That recovery path is deliberately narrow: it can
 * only process a recording owned by the authenticated user. A force=true query
 * is reserved for refreshing an already-ready memory from its sealed 30-second
 * transcript windows. Force rebuilds never call STT and never rewrite the
 * people/follow-up/retrieval indexes; they refresh the recording memory + day
 * brief only.
 */

import { Router } from 'express';
import { z } from 'zod';
import { processRecording } from '../../pipeline/process.js';
import * as db from '../../store/firestore.js';
import { log } from '../../util/log.js';
import { requireAuth, requireTaskAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const taskBody = z.object({
  uid: z.string().min(1),
  recordingId: z.string().min(1),
});

const ACTIVE_STATES = new Set(['transcribing', 'understanding', 'indexing']);

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
        await processRecording(uid, recordingId);
        res.status(200).json({ state: 'ready' });
      } catch (cause) {
        const message = (cause as Error).message ?? '';
        // A 4xx tells Cloud Tasks to stop retrying. Reserve it for failures that
        // will never succeed — a missing recording, no audio at all. Everything
        // else gets a 5xx so the queue's backoff can do its job.
        const permanent = /unknown (user|recording)|no segments|no audio/i.test(message);
        log.error('Task processing failed', { uid, recordingId, permanent, error: message });
        res.status(permanent ? 400 : 500).json({
          error: { code: permanent ? 'permanent' : 'transient', message },
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

      // If Cloud Tasks started between the PWA's last poll and this request,
      // leave that worker alone rather than starting a second pipeline.
      if (ACTIVE_STATES.has(recording.state)) {
        res.status(202).json({ recording_id: recordingId, state: recording.state, recovered: false });
        return;
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
        await db.patchRecording(req.uid, recordingId, {
          state: 'uploaded',
          progress: 0,
          errorCode: null,
          retryable: false,
        });
      } else {
        if (recording.state === 'failed' && !recording.retryable) {
          throw new HttpError(409, 'not_retryable', recording.errorCode || 'Processing cannot be retried');
        }
        if (recording.state !== 'uploaded' && recording.state !== 'failed') {
          throw new HttpError(409, 'not_ready', `Recording is ${recording.state}`);
        }
        log.warn('Using authenticated processing recovery', { uid: req.uid, recordingId, state: recording.state });
      }

      try {
        await processRecording(
          req.uid,
          recordingId,
          rebuild ? { skipTranscription: true, memoryOnly: true } : {},
        );
      } catch (cause) {
        if (rebuild) {
          // processRecording marks failures as failed. For a best-effort legacy
          // refresh that would hide a perfectly usable old memory, so restore the
          // ready status and leave the existing sealed memory available.
          await db.patchRecording(req.uid, recordingId, {
            state: 'ready',
            progress: 1,
            errorCode: null,
            retryable: false,
          });
        }
        throw cause;
      }

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
