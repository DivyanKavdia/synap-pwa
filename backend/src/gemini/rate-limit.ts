import { createHash } from 'node:crypto';

const MAX_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A provider wait at least this long is a daily or rolling-window quota,
 * whatever the response called it. No per-minute limit is answered with an
 * hour of backoff.
 */
export const LONG_QUOTA_MS = 60 * 60 * 1000;

/** How widely a long shared wait is spread across the recordings it blocked. */
const SPREAD_WINDOW_MS = 15 * 60 * 1000;

/**
 * Deterministic offset added to a long shared cooldown deadline.
 *
 * Every recording blocked by one model cooldown reads the same deadline, so
 * without this they all wake inside the same second, spend whatever quota the
 * window just released, and earn the next block. That is how a 13-hour wait
 * became a 24-hour wait renewing itself every morning at 05:30.
 *
 * The offset is derived from the recording id rather than randomised. The
 * stored processingFailure.retryAt is what actually keeps the Cloud Tasks dedup
 * name stable across redeliveries, but a deterministic offset adds no new
 * variance to it and keeps this testable.
 *
 * Short waits are left alone. Spreading a one-minute rate limit would only add
 * latency to something that clears on its own.
 */
export function retrySpreadMs(
  recordingId: string,
  retryAfterMs: number,
  windowMs = SPREAD_WINDOW_MS,
): number {
  if (!(retryAfterMs >= LONG_QUOTA_MS) || !(windowMs > 0)) return 0;
  return createHash('sha256').update(recordingId).digest().readUInt32BE(0) % Math.ceil(windowMs);
}

export interface RateLimitAdvice {
  retryAfterMs: number;
  quotaKind: 'rate' | 'daily' | 'unknown';
}

export interface ModelCooldownState {
  until: number;
  quotaKind: RateLimitAdvice['quotaKind'];
  failures?: number;
  lastRejectedAt?: number;
}

/** Only a provider rejection advances backoff. Concurrent rejections share one
 * cooldown; reading a saved deadline never extends it or adds another failure. */
export function rejectedModelCooldown(
  previous: ModelCooldownState | undefined,
  advice: RateLimitAdvice,
  now: number,
): ModelCooldownState {
  const active = Boolean(previous && previous.until > now);
  const recent = Boolean(previous?.lastRejectedAt !== undefined &&
    now >= previous.lastRejectedAt && now - previous.lastRejectedAt < 3600000);
  const priorFailures = Math.max(1, Math.min(5, previous?.failures || 1));
  const failures = active ? priorFailures : recent ? Math.min(5, priorFailures + 1) : 1;
  const delay = active ? advice.retryAfterMs
    : Math.max(advice.retryAfterMs, Math.min(900000, 60000 * 2 ** (failures - 1)));
  return {
    until: Math.max(previous?.until || 0, now + delay),
    quotaKind: active && previous?.quotaKind === 'daily' ? 'daily' : advice.quotaKind,
    failures,
    lastRejectedAt: now,
  };
}

function positiveDelay(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(MAX_RETRY_MS, Math.ceil(value)) : 0;
}

const PACIFIC_ZONE = 'America/Los_Angeles';
const pacificClock = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(at: number): Record<string, number> {
  const values: Record<string, number> = {};
  for (const part of pacificClock.formatToParts(new Date(at)))
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  return values;
}

function pacificOffsetMs(at: number): number {
  const p = zonedParts(at);
  const represented = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return represented - Math.floor(at / 1000) * 1000;
}

function pacificMidnightUtc(year: number, month: number, day: number): number {
  const wall = Date.UTC(year, month - 1, day, 0, 0, 0);
  let utc = wall;
  // Two passes are sufficient across DST boundaries; a third is cheap insurance
  // against an offset change between the initial UTC guess and Pacific midnight.
  for (let pass = 0; pass < 3; pass++) utc = wall - pacificOffsetMs(utc);
  return utc;
}

/** Gemini RPD resets at midnight Pacific, including PDT/PST transitions. */
export function pacificDailyResetDelayMs(now = Date.now()): number {
  const current = zonedParts(now);
  const nextCalendar = new Date(Date.UTC(current.year!, current.month! - 1, current.day! + 1));
  const reset = pacificMidnightUtc(
    nextCalendar.getUTCFullYear(),
    nextCalendar.getUTCMonth() + 1,
    nextCalendar.getUTCDate(),
  );
  return positiveDelay(reset - now);
}

/** Read only timing and quota category, never return provider messages or identifiers. */
export function rateLimitAdvice(
  header: string | null,
  body: string,
  now = Date.now(),
): RateLimitAdvice {
  let retryAfterMs =
    header && /^\d+(?:\.\d+)?$/.test(header.trim())
      ? positiveDelay(Number(header) * 1000)
      : header
        ? positiveDelay(Date.parse(header) - now)
        : 0;
  let quotaKind: RateLimitAdvice['quotaKind'] = 'unknown';
  try {
    const details = JSON.parse(body)?.error?.details;
    if (Array.isArray(details))
      for (const detail of details) {
        if (detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
          const delay = detail.retryDelay;
          const milliseconds =
            typeof delay === 'string' && /^\d+(?:\.\d+)?s$/.test(delay)
              ? Number(delay.slice(0, -1)) * 1000
              : delay && typeof delay === 'object'
                ? Number(delay.seconds || 0) * 1000 + Number(delay.nanos || 0) / 1e6
                : 0;
          retryAfterMs = Math.max(retryAfterMs, positiveDelay(milliseconds));
        }
        if (
          detail?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' &&
          Array.isArray(detail.violations)
        ) {
          for (const violation of detail.violations) {
            const metric = [violation?.quotaMetric, violation?.quotaId]
              .filter((value) => typeof value === 'string')
              .join(' ');
            if (/per[_ -]?day|daily/i.test(metric)) quotaKind = 'daily';
            else if (quotaKind !== 'daily' && /per[_ -]?minute|per[_ -]?second/i.test(metric))
              quotaKind = 'rate';
          }
        }
      }
  } catch {
    /* A non-JSON provider response still receives conservative backoff. */
  }
  const effective = Math.max(
    retryAfterMs,
    quotaKind === 'daily' ? pacificDailyResetDelayMs(now) : 60000,
  );
  return {
    // Relabel only after the timing is settled. Classifying earlier would let
    // the Pacific-midnight floor stretch a shorter provider wait, and the
    // point here is truthful logs, not a longer block: a 24-hour wait logged
    // as quotaKind "unknown" is what sent us auditing our own arithmetic
    // instead of the daily request limit that actually caused it.
    quotaKind: quotaKind === 'unknown' && effective >= LONG_QUOTA_MS ? 'daily' : quotaKind,
    retryAfterMs: effective,
  };
}

/** Per-runtime suppression; browser jobs also persist their cooldown across reloads. */
export class ModelCooldowns {
  private readonly models = new Map<string, ModelCooldownState>();

  remaining(model: string, now = Date.now()): RateLimitAdvice | undefined {
    const entry = this.models.get(model);
    if (!entry) return;
    if (entry.until <= now) return;
    return { quotaKind: entry.quotaKind, retryAfterMs: Math.ceil(entry.until - now) };
  }

  defer(model: string, advice: RateLimitAdvice, now = Date.now()): void {
    const previous = this.models.get(model);
    const until = now + advice.retryAfterMs;
    if ((previous?.until || 0) < until) this.models.set(model, { ...previous, until, quotaKind: advice.quotaKind });
  }

  reject(model: string, advice: RateLimitAdvice, now = Date.now()): RateLimitAdvice {
    const next = rejectedModelCooldown(this.models.get(model), advice, now);
    this.models.set(model, next);
    return { retryAfterMs: Math.ceil(next.until - now), quotaKind: next.quotaKind };
  }
}
