/** Runs only synthetic data through the same session, upload and task APIs as the PWA. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { keyring } from '../crypto/keyring.js';
import { sealJson } from '../crypto/envelope.js';
import { issueTokens } from '../http/auth.js';
import { createInteraction, embedContent, interactionText, GeminiError, modelFailure } from '../gemini/client.js';
import * as db from '../store/firestore.js';
import { deleteUserAudio } from '../store/gcs.js';
import type { UserDoc } from '../store/types.js';

interface Check { name: string; ok: boolean; code?: string; httpStatus?: number; providerStatus?: number; quotaKind?: string }
class ProbeFailure extends Error {
  constructor(readonly detail: Omit<Check, 'name' | 'ok'>) { super(detail.code || 'probe_failed'); }
}

/** Do not copy provider messages, API responses, tokens or fixture contents into CI logs. */
export function safeProbeFailure(cause: unknown): Omit<Check, 'name' | 'ok'> {
  if (cause instanceof ProbeFailure) return cause.detail;
  if (cause instanceof GeminiError) {
    const failure = modelFailure(cause);
    return { code: failure.code, providerStatus: failure.providerStatus,
      ...(failure.quotaKind ? { quotaKind: failure.quotaKind } : {}) };
  }
  const code = (cause as { code?: unknown })?.code;
  return { code: typeof code === 'number' ? `dependency_${code}` : 'check_failed' };
}

export async function runReadinessProbe() {
  const uid = `ops-probe-${randomUUID()}`, recordingId = randomUUID();
  const checks: Check[] = [];
  const started = Date.now(), day = new Date().toISOString().slice(0, 10);
  const signal = AbortSignal.timeout(240_000);
  let stage = 'key_and_session', created = false;
  const check = (name: string) => { checks.push({ name, ok: true }); };
  try {
    const { wrapped, dek } = await keyring.create(uid);
    const now = new Date().toISOString();
    const user: UserDoc = { uid, googleSubject: uid, key: wrapped,
      sealedProfile: sealJson(dek, { email: '', name: 'Synthetic readiness check', picture: '' },
        { uid, scope: `user/${uid}`, field: 'profile' }),
      createdAt: now, lastSeenAt: now, tokenGeneration: 1, audioRetentionDays: 1 };
    created = true;
    await db.putUser(user);
    const { access_token } = await issueTokens(user);
    // Discard the cached DEK so the first HTTP request also proves KMS decryption.
    keyring.forget(uid);
    const call = async (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => {
      const response = await fetch(`http://127.0.0.1:${config.port}/v1${path}`, {
        method, signal, headers: { Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json', ...extra },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
      });
      const value = await response.json() as Record<string, any>;
      if (!response.ok) {
        const error = value.error || {};
        throw new ProbeFailure({ code: /^[a-z_]{1,60}$/.test(error.code) ? error.code : 'http_failed',
          httpStatus: response.status, ...(Number.isInteger(error.providerStatus) ? { providerStatus: error.providerStatus } : {}),
          ...(['rate', 'daily', 'unknown'].includes(error.quotaKind) ? { quotaKind: error.quotaKind } : {}) });
      }
      return value;
    };
    await call('/recordings', 'POST', { recording_id: recordingId, started_at: now, timezone: 'UTC', language: 'en-US' });
    check(stage);
    const audio = await readFile(new URL('../../../fixtures/readiness.wav', import.meta.url));
    stage = 'audio_storage_and_transcription';
    await call(`/recordings/${recordingId}/segments/0`, 'PUT', audio,
      { 'Content-Type': 'audio/wav', 'X-Synap-Start-Ms': '0', 'X-Synap-End-Ms': '6885' });
    check(stage);
    stage = 'cloud_tasks_and_memory';
    await call(`/recordings/${recordingId}/finalize`, 'POST', {
      ended_at: new Date(Date.parse(now) + 6885).toISOString(), duration_ms: 6885, segment_count: 1,
    }, { 'Idempotency-Key': `probe-${recordingId}` });
    let ready = false;
    while (!signal.aborted) {
      const status = await call(`/recordings/${recordingId}/processing`);
      if (status.state === 'ready') { ready = true; break; }
      if (status.state === 'failed') throw new ProbeFailure({
        code: /^[a-z_]{1,60}$/.test(status.error?.code) ? status.error.code : 'processing_failed',
        ...(Number.isInteger(status.error?.providerStatus) ? { providerStatus: status.error.providerStatus } : {}),
      });
      await sleep(1500, undefined, { signal });
    }
    if (!ready) throw new ProbeFailure({ code: 'queue_timeout' });
    check(stage);
    stage = 'transcript_and_summary';
    const memory = await call(`/recordings/${recordingId}/memory`);
    if (!/report/i.test(memory.transcript || '') || !(memory.executive_summary || '').trim())
      throw new ProbeFailure({ code: 'fixture_content_missing' });
    check(stage);
    stage = 'retrieval_indexes';
    await db.listRecordingsByDay(uid, day);
    await db.recentConversations(uid, 5, { from: day, to: day });
    await db.listFollowUps(uid, 'open', 'all', 5);
    await db.listFollowUps(uid, 'all', 'self', 5);
    await db.listFollowUps(uid, 'open', 'self', 5);
    const vector = await embedContent('project report', 'RETRIEVAL_QUERY', signal);
    if (vector.length !== config.gemini.embedDimensions) throw new ProbeFailure({ code: 'embedding_dimension_mismatch' });
    const nearest = await db.findNearestConversations(uid, vector, 5);
    if (!nearest.length) throw new ProbeFailure({ code: 'retrieval_empty' });
    check(stage);
    stage = 'ask_synap';
    // Query parsing and Ask have product fallbacks. Probe distinct model routes
    // explicitly so a fallback cannot make a broken model look ready.
    for (const model of new Set([config.gemini.queryModel, config.gemini.askModel])) {
      const output = await createInteraction({ model, input: 'Reply with the single word OK.', usage_label: 'readiness' }, signal);
      if (!/\bok\b/i.test(interactionText(output))) throw new ProbeFailure({ code: 'model_probe_empty' });
    }
    const answer = await call('/ask', 'POST', { query: 'What was decided about the project report?', scope: { from: day, to: day } });
    if (!JSON.stringify(answer).toLowerCase().includes('report')) throw new ProbeFailure({ code: 'answer_missing' });
    check(stage);
  } catch (cause) {
    checks.push({ name: stage, ok: false, ...safeProbeFailure(cause) });
  } finally {
    if (created) {
      try {
        // Only the random, locally generated fixture namespace may be removed.
        await db.beginRecordingDeletion(uid, recordingId);
        await deleteUserAudio(uid);
        await db.deleteUser(uid);
        check('fixture_cleanup');
      } catch { checks.push({ name: 'fixture_cleanup', ok: false, code: 'cleanup_failed' }); }
    }
    keyring.forget(uid);
  }
  return { ok: checks.length > 0 && checks.every(check => check.ok), commit: config.build.commit,
    durationMs: Date.now() - started, checks };
}
