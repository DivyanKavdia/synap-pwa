import { Router } from 'express';
import { z } from 'zod';
import {
  createMemoryMerge,
  deleteMemoryMerge,
  listMemoryMerges,
  MemoryMergeError,
  type MemoryMergeView,
} from '../../pipeline/merge.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const mergeBody = z.object({
  recording_ids: z.array(z.string().min(1)).min(2).max(5),
});

function view(merge: MemoryMergeView) {
  return {
    merge_id: merge.mergeId,
    source_recording_ids: merge.sourceRecordingIds,
    day: merge.day,
    started_at: merge.startedAt,
    ended_at: merge.endedAt,
    duration_ms: merge.durationMs,
    memory: merge.memory,
    transcript: merge.transcript,
    created_at: merge.createdAt,
  };
}

function translate(error: unknown): never {
  if (error instanceof MemoryMergeError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

/**
 * Source-safe memory tools. Merging never mutates or deletes recordings; it
 * creates one encrypted derived view. DELETE therefore means "Unmerge" and is
 * immediately reversible from the untouched source memories.
 */
export function memoryToolRoutes(): Router {
  const router = Router();

  router.get(
    '/memory-merges',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const day = req.query.day === undefined ? undefined : String(req.query.day);
      if (day !== undefined && !DAY_PATTERN.test(day)) {
        throw new HttpError(400, 'bad_request', 'Day must be YYYY-MM-DD');
      }
      const merges = await listMemoryMerges(req.uid, req.dek, day);
      res.status(200).json({ merges: merges.map(view), max_sources: 5, consecutive_only: true });
    }),
  );

  router.post(
    '/memory-merges',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const body = mergeBody.safeParse(req.body);
      if (!body.success) {
        throw new HttpError(400, 'bad_request', 'Choose between 2 and 5 memory IDs.');
      }
      try {
        const merge = await createMemoryMerge(req.uid, req.dek, body.data.recording_ids);
        res.status(201).json(view(merge));
      } catch (error) {
        translate(error);
      }
    }),
  );

  router.delete(
    '/memory-merges/:mergeId',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const removed = await deleteMemoryMerge(req.uid, String(req.params.mergeId));
      if (!removed) throw new HttpError(404, 'not_found', 'Unknown merged memory');
      res.status(200).json({ merge_id: String(req.params.mergeId), unmerged: true });
    }),
  );

  return router;
}
