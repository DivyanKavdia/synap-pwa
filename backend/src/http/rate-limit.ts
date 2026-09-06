/**
 * Rate limiting for unauthenticated endpoints.
 *
 * Cloud Run scales horizontally, so an in-process counter limits one instance
 * and nothing else — under load the limit silently multiplies by the instance
 * count. The counter therefore lives in Firestore, which every instance shares.
 *
 * This is a fixed window rather than a sliding one. A fixed window allows up to
 * twice the limit across a boundary, which for abuse prevention is an
 * acceptable trade for one read-modify-write per request instead of a sorted
 * set of timestamps. The point is to stop unbounded document creation, not to
 * meter an API precisely.
 *
 * Counter documents carry `expireAt` so the same Firestore TTL policy that
 * reaps pairings reaps these too.
 */

import { firestore } from '../store/firestore.js';
import { sha256 } from '../util/ids.js';
import { HttpError } from './errors.js';
import type { NextFunction, Request, Response } from 'express';

const COLLECTION = 'rateLimits';

export interface RateLimitOptions {
  /** Distinguishes counters for different endpoints. */
  bucket: string;
  limit: number;
  windowMs: number;
}

/**
 * Cloud Run puts the caller first in X-Forwarded-For and appends its own proxy
 * hops. `app.set('trust proxy')` makes Express resolve that to req.ip, but a
 * client can still send a forged header, so the value is only ever a
 * best-effort grouping key — never an identity. It is hashed because a raw IP
 * is personal data and this document is not encrypted.
 */
function clientKey(req: Request): string {
  const forwarded = (req.header('x-forwarded-for') ?? '').split(',')[0]?.trim();
  return sha256(forwarded || req.ip || 'unknown').slice(0, 32);
}

export async function consume(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const ref = firestore().collection(COLLECTION).doc(`${bucket}_${key}_${windowStart}`);

  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const count = (snapshot.data()?.count as number | undefined) ?? 0;
    const resetMs = windowStart + windowMs - now;

    if (count >= limit) return { allowed: false, remaining: 0, resetMs };

    tx.set(
      ref,
      {
        count: count + 1,
        bucket,
        windowStart: new Date(windowStart).toISOString(),
        // Kept a full window past expiry so a late request in the same window
        // still sees the count rather than starting fresh.
        expireAt: new Date(windowStart + windowMs * 2),
      },
      { merge: true },
    );
    return { allowed: true, remaining: limit - count - 1, resetMs };
  });
}

export function rateLimit(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await consume(
        options.bucket,
        clientKey(req),
        options.limit,
        options.windowMs,
      );
      res.setHeader('X-RateLimit-Limit', String(options.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));

      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.ceil(result.resetMs / 1000)));
        throw new HttpError(429, 'rate_limited', 'Too many requests. Try again shortly.', true);
      }
      next();
    } catch (cause) {
      // Firestore being unavailable must not take down sign-in. Limiting is a
      // guard rail, not an authorization decision, so it fails open — but only
      // for infrastructure faults, never for an actual limit breach.
      if (cause instanceof HttpError) return next(cause);
      next();
    }
  };
}
