const MAX_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface RateLimitAdvice {
  retryAfterMs: number;
  quotaKind: 'rate' | 'daily' | 'unknown';
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
  private readonly models = new Map<string, RateLimitAdvice & { until: number }>();

  remaining(model: string, now = Date.now()): RateLimitAdvice | undefined {
    const entry = this.models.get(model);
    if (!entry) return;
    if (entry.until <= now) {
      this.models.delete(model);
      return;
    }
    return { quotaKind: entry.quotaKind, retryAfterMs: Math.ceil(entry.until - now) };
  }

  defer(model: string, advice: RateLimitAdvice, now = Date.now()): void {
    const until = now + advice.retryAfterMs;
    if ((this.models.get(model)?.until || 0) < until) this.models.set(model, { ...advice, until });
  }
}
