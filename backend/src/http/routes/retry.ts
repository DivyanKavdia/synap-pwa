import { Router } from 'express';
import { enqueueProcessing } from '../../pipeline/queue.js';
import * as db from '../../store/firestore.js';
import { fingerprint } from '../../util/ids.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const ACTIVE_STATES = new Set(['transcribing', 'understanding', 'indexing']);
const UPLOAD_STATES = new Set(['created', 'uploading']);

function idempotencyKey(req: AuthedRequest): string {
  const key = req.header('idempotency-key');
  if (!key || key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  }
  return key;
}

/**
 * Explicit user retry for a processing failure.
 *
 * Retry is deliberately convergent across the browser's durable FIFO and the
 * cloud state. A local upload/consolidate job can exhaust its attempts while
 * Cloud Tasks has already advanced the same recording. Treating every state
 * except `failed` as an error made the Retry button brittle: a harmless 409
 * prevented the local failed job from being reset at all.
 *
 * The rules are therefore:
 *   - ready: already complete, success/no-op
 *   - active cloud worker: already processing, success/no-op
 *   - created/uploading: let the browser resend/finish its failed upload
 *   - uploaded: start a fresh uniquely-named processing task
 *   - retryable failed: reset to uploaded and start a fresh task
 *   - non-retryable failed / unknown state: remain blocked
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
        res.status(200).json({
          recording_id: recordingId,
          state: 'ready',
          retry_started: false,
          already_complete: true,
        });
        return;
      }

      // The cloud may have recovered between the last status poll and the user's
      // tap. That is success, not a conflict. The local FIFO can now clear its
      // own failed job and resume polling the same recording.
      if (ACTIVE_STATES.has(recording.state)) {
        res.status(202).json({
          recording_id: recordingId,
          state: recording.state,
          retry_started: false,
          already_processing: true,
        });
        return;
      }

      // Rolling transcription happens during PUT /segments. If one local upload
      // job failed repeatedly, Firestore can still truthfully be created or
      // uploading. Returning 202 lets the selected local job reset and resend
      // the idempotent segment instead of being stopped by a false not_failed.
      if (UPLOAD_STATES.has(recording.state)) {
        res.status(202).json({
          recording_id: recordingId,
          state: recording.state,
          retry_started: false,
          awaiting_upload: true,
        });
        return;
      }

      if (recording.state !== 'failed' && recording.state !== 'uploaded') {
        throw new HttpError(409, 'not_retryable_state', `Recording is ${recording.state}`, true);
      }
      if (recording.state === 'failed' && !recording.retryable) {
        throw new HttpError(
          409,
          'not_retryable',
          recording.errorCode || 'This processing failure cannot be retried',
          false,
        );
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

      // `uploaded` is also reset intentionally. It may represent a task that was
      // accepted but lost/expired before a worker started. An explicit user retry
      // gets a fresh task suffix, while the idempotency ledger still protects a
      // repeated tap from duplicating that task.
      await db.patchRecording(req.uid, recordingId, {
        state: 'uploaded',
        progress: 0,
        errorCode: null,
        retryable: false,
      });

      const taskSuffix = `retry-${fingerprint(key).slice(0, 20)}`;
      try {
        await enqueueProcessing(req.uid, recordingId, taskSuffix);
      } catch (cause) {
        await db.patchRecording(req.uid, recordingId, {
          state: 'failed',
          errorCode: `Could not queue retry: ${(cause as Error).message}`.slice(0, 200),
          retryable: true,
        });
        throw cause;
      }

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
