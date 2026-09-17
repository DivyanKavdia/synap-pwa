import type { NextFunction, Request, Response } from 'express';
import { GeminiError, modelFailure } from '../gemini/client.js';
import { log } from '../util/log.js';
import { SegmentWriteError, TranscriptionBusyError } from '../store/firestore.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Terminal error handler.
 *
 * Client errors return their own message because the caller can act on them.
 * Server errors return a generic string: an exception message from Firestore or
 * KMS can name internal resources, and this API is reachable from a browser.
 * The detail still reaches Cloud Logging.
 */
export function errorHandler() {
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    if (error instanceof HttpError) {
      if (error.status >= 500) log.error('Request failed', { path: req.path, code: error.code });
      res.status(error.status).json({
        error: { code: error.code, message: error.message, retryable: error.retryable },
      });
      return;
    }

    if (error instanceof GeminiError) {
      const failure = modelFailure(error);
      log.error('Gemini call failed', { path: req.path, ...failure });
      if (failure.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(failure.retryAfterMs / 1000)));
      res.status(error.retryable ? 503 : 502).json({
        error: failure,
      });
      return;
    }

    if (error instanceof SegmentWriteError) {
      const busy = error instanceof TranscriptionBusyError;
      if (busy) res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      res.status(error.status).json({ error: { code: busy ? error.code : 'segment_conflict',
        message: error.message, retryable: error.retryable,
        ...(busy ? { retryAfterMs: error.retryAfterMs } : {}) } });
      return;
    }

    const status = (error as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({
        error: { code: 'bad_request', message: (error as Error).message, retryable: false },
      });
      return;
    }

    log.error('Unhandled error', { path: req.path, error: (error as Error).message });
    res.status(500).json({
      error: { code: 'internal', message: 'Something went wrong.', retryable: true },
    });
  };
}

/** Wrap an async handler so a rejected promise reaches the error handler. */
export function handler<T extends Request>(
  fn: (req: T, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req as T, res).catch(next);
  };
}
