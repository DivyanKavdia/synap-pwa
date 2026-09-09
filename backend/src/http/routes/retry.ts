import { Router } from 'express';
import { enqueueProcessing } from '../../pipeline/queue.js';
import * as db from '../../store/firestore.js';
import { fingerprint } from '../../util/ids.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

function idempotencyKey(req: AuthedRequest): string {
  const key = req.header('idempotency-key');
  if (!key || key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  }
  return key;
}

/**
 * Explicit user retry for a backend processing failure.
 *
 * The normal finalize request is idempotent and Cloud Tasks deliberately
 * deduplicates it. That is correct for accidental double-finalize, but it also
 * means replaying finalize cannot recover a task that already ran and failed.
 * This route creates a fresh task only when Firestore says the recording really
 * failed and the failure is retryable.
 */
export function retryRoutes(): Router {
  const router = Router();

  router.post(
    '/recordings/:recordingId/retry',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const recordingId = String(req.params.recordingId);
      const recording = await db.getRecording(req.uid, recordingId);
      if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');

      if (recording.state === 'ready') {
        res.status(200).json({ recording_id: recordingId, state: 'ready', retry_started: false });
        return;
      }
      if (recording.state !== 'failed') {
        throw new HttpError(409, 'not_failed', `Recording is ${recording.state}`, true);
      }
      if (!recording.retryable) {
        throw new HttpError(409, 'not_retryable', recording.errorCode || 'This processing failure cannot be retried', false);
      }

      const uploaded = await db.countSegments(req.uid, recordingId);
      if (uploaded === 0) {
        throw new HttpError(409, 'no_segments', 'No uploaded audio is available to retry', false);
      }

      const key = idempotencyKey(req);
      const claim = await db.claimIdempotencyKey(
        req.uid,
        key,
        fingerprint({ action: 'retry_processing', recordingId }),
      );
      if (!claim.fresh && claim.response) {
        res.status(202).json(claim.response);
        return;
      }

      await db.patchRecording(req.uid, recordingId, {
        state: 'uploaded',
        progress: 0,
        errorCode: null,
        retryable: false,
      });

      // A unique suffix bypasses the normal one-hour completed-task dedupe
      // window while the idempotency ledger still protects a repeated tap.
      const taskSuffix = `retry-${fingerprint(key).slice(0, 20)}`;
      await enqueueProcessing(req.uid, recordingId, taskSuffix);

      const response = {
        recording_id: recordingId,
        state: 'uploaded',
        retry_started: true,
        uploaded_segments: uploaded,
      };
      await db.completeIdempotencyKey(req.uid, key, response);
      res.status(202).json(response);
    }),
  );

  return router;
}
