const MAX_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

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
  return {
    quotaKind,
    retryAfterMs: Math.max(retryAfterMs, quotaKind === 'daily' ? 3600000 : 60000),
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
