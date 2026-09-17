/** Service-wide quota timing only. No user IDs, audio, text, or credentials. */
import { createHash } from 'node:crypto';
import { firestore } from './firestore.js';
import type { RateLimitAdvice } from '../gemini/rate-limit.js';

const ref = (model: string) => firestore().collection('serviceModelCooldowns')
  .doc(createHash('sha256').update(model).digest('hex'));

export async function sharedModelCooldown(model: string, now = Date.now()): Promise<RateLimitAdvice | undefined> {
  const value = (await ref(model).get()).data();
  if (!value || !Number.isFinite(value.until) || value.until <= now) return;
  return { retryAfterMs: Math.ceil(value.until - now),
    quotaKind: value.quotaKind === 'daily' ? 'daily' : value.quotaKind === 'rate' ? 'rate' : 'unknown' };
}

export async function deferSharedModel(model: string, advice: RateLimitAdvice, now = Date.now()): Promise<void> {
  const target = ref(model), until = now + advice.retryAfterMs;
  await firestore().runTransaction(async tx => {
    const previous = (await tx.get(target)).data();
    if ((previous?.until || 0) < until) tx.set(target, { until, quotaKind: advice.quotaKind });
  });
}
