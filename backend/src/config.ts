/**
 * Runtime configuration.
 *
 * Everything here is read once at boot. Secrets (Gemini AI Studio key, session
 * signing key) are NOT read from plain env vars in production — Cloud Run mounts
 * them from Secret Manager, and `loadSecrets()` resolves them at startup so a
 * rotated secret is picked up by the next revision rather than per-request.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export interface Secrets {
  /** Gemini AI Studio API key (generativelanguage.googleapis.com). */
  geminiApiKey: string;
  /** HMAC key for Synap session tokens. */
  sessionSigningKey: Uint8Array;
}

export const config = {
  projectId: required('GOOGLE_CLOUD_PROJECT'),
  location: optional('SYNAP_LOCATION', 'asia-south1'),
  port: Number(optional('PORT', '8080')),

  /**
   * Which build is running. Set at deploy time; empty in local development.
   * Optional on purpose — a missing value shows as "unknown" on /health rather
   * than stopping the service from booting.
   */
  build: {
    commit: optional('SYNAP_BUILD_SHA', ''),
    builtAt: optional('SYNAP_BUILD_TIME', ''),
  },

  /** Google OAuth client ID the PWA signs in with. Audience for ID token checks. */
  googleClientId: required('SYNAP_GOOGLE_CLIENT_ID'),

  /** Origins allowed to call /v1 with credentials. Comma separated. */
  allowedOrigins: optional(
    'SYNAP_ALLOWED_ORIGINS',
    'https://divyankavdia.github.io',
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  storage: {
    /** Bucket holding envelope-encrypted audio segments. */
    audioBucket: required('SYNAP_AUDIO_BUCKET'),
    /** Days after which raw audio objects are deleted by lifecycle policy. */
    audioRetentionDays: Number(optional('SYNAP_AUDIO_RETENTION_DAYS', '30')),
  },

  kms: {
    keyRing: optional('SYNAP_KMS_KEY_RING', 'synap'),
    /** CMEK that wraps each user's data encryption key. */
    keyId: optional('SYNAP_KMS_KEY_ID', 'user-kek'),
    location: optional('SYNAP_KMS_LOCATION', 'asia-south1'),
    /** How long an unwrapped DEK may stay in process memory. */
    dekCacheTtlMs: Number(optional('SYNAP_DEK_CACHE_TTL_MS', '300000')),
  },

  tasks: {
    queue: optional('SYNAP_TASKS_QUEUE', 'synap-processing'),
    location: optional('SYNAP_TASKS_LOCATION', 'asia-south1'),
    /** Public URL of this service, used as the Cloud Tasks target. */
    serviceUrl: optional('SYNAP_SERVICE_URL', ''),
    /** Service account Cloud Tasks mints an OIDC token for. */
    invokerServiceAccount: optional('SYNAP_TASKS_INVOKER_SA', ''),
  },

  gemini: {
    endpoint: optional(
      'SYNAP_GEMINI_ENDPOINT',
      'https://generativelanguage.googleapis.com/v1beta',
    ),
    /**
     * Dedicated ASR model. Handles 85+ languages with mid-utterance
     * code-switching, which is what Hinglish capture actually needs.
     * Diarization/word timestamps cap a request at 30 minutes of audio;
     * Synap uploads ~30 second segments, so that ceiling is never near.
     */
    transcribeModel: optional('SYNAP_GEMINI_STT_MODEL', 'gemini-3.5-transcribe'),
    /** Structured memory extraction, daily brief and Ask Synap answering. */
    memoryModel: optional('SYNAP_GEMINI_LLM_MODEL', 'gemini-3.5-flash'),
    embedModel: optional('SYNAP_GEMINI_EMBED_MODEL', 'gemini-embedding-001'),
    /** 768 keeps Firestore vector indexes cheap and is a documented sweet spot. */
    embedDimensions: Number(optional('SYNAP_GEMINI_EMBED_DIMENSIONS', '768')),
    requestTimeoutMs: Number(optional('SYNAP_GEMINI_TIMEOUT_MS', '120000')),
  },

  /**
   * Optional private speaker-embedding service. It is deliberately separate
   * from Gemini transcription: if speaker verification is unavailable, Synap
   * still records, transcribes and understands the meeting normally.
   */
  speaker: {
    serviceUrl: optional('SYNAP_SPEAKER_SERVICE_URL', '').replace(/\/+$/, ''),
    authMode: optional('SYNAP_SPEAKER_SERVICE_AUTH', 'oidc') as 'oidc' | 'none',
    requestTimeoutMs: Number(optional('SYNAP_SPEAKER_TIMEOUT_MS', '30000')),
    /** Conservative defaults; tune only against real pendant recordings. */
    matchThreshold: Number(optional('SYNAP_SPEAKER_MATCH_THRESHOLD', '0.72')),
    minMatchMargin: Number(optional('SYNAP_SPEAKER_MATCH_MARGIN', '0.06')),
    minSampleMs: Number(optional('SYNAP_SPEAKER_MIN_SAMPLE_MS', '2500')),
    maxSampleMs: Number(optional('SYNAP_SPEAKER_MAX_SAMPLE_MS', '8000')),
  },

  session: {
    /** Short-lived bearer token the PWA sends on every /v1 call. */
    accessTokenTtlSeconds: Number(optional('SYNAP_ACCESS_TTL', '3600')),
    /** Long-lived refresh token so background processing survives a locked phone. */
    refreshTokenTtlSeconds: Number(optional('SYNAP_REFRESH_TTL', '2592000')),
    issuer: 'https://synap.app',
  },

  limits: {
    /** Inline audio ceiling for the Gemini request is 20 MB total. */
    maxSegmentBytes: Number(optional('SYNAP_MAX_SEGMENT_BYTES', String(12 * 1024 * 1024))),
    maxAskSources: 8,
  },
} as const;

const PLACEHOLDER_GEMINI_KEY = 'REPLACE_WITH_YOUR_GEMINI_API_KEY';

let cachedSecrets: Secrets | null = null;

async function readSecret(client: SecretManagerServiceClient, name: string): Promise<string> {
  // Accept either a bare secret id or a fully qualified version resource.
  const resource = name.includes('/secrets/')
    ? name
    : `projects/${config.projectId}/secrets/${name}/versions/latest`;
  const [version] = await client.accessSecretVersion({ name: resource });
  const payload = version.payload?.data;
  if (!payload) throw new Error(`Secret ${name} has no payload`);
  return Buffer.from(payload).toString('utf8').trim();
}

/**
 * Resolve secrets once per process. Local development can short-circuit this
 * with plain env vars; Cloud Run points the *_SECRET vars at Secret Manager.
 */
export async function loadSecrets(): Promise<Secrets> {
  if (cachedSecrets) return cachedSecrets;

  const inlineGemini = process.env.SYNAP_GEMINI_API_KEY;
  const inlineSession = process.env.SYNAP_SESSION_SIGNING_KEY;

  if (inlineGemini && inlineSession) {
    cachedSecrets = {
      geminiApiKey: inlineGemini,
      sessionSigningKey: Buffer.from(inlineSession, 'base64'),
    };
    return cachedSecrets;
  }

  const client = new SecretManagerServiceClient();
  const [geminiApiKey, sessionSigningKey] = await Promise.all([
    inlineGemini
      ? Promise.resolve(inlineGemini)
      : readSecret(client, required('SYNAP_GEMINI_API_KEY_SECRET')),
    inlineSession
      ? Promise.resolve(inlineSession)
      : readSecret(client, required('SYNAP_SESSION_SIGNING_KEY_SECRET')),
  ]);

  const key = Buffer.from(sessionSigningKey, 'base64');
  if (key.length < 32) {
    throw new Error('Session signing key must decode to at least 32 bytes');
  }

  if (geminiApiKey === PLACEHOLDER_GEMINI_KEY) {
    // Terraform seeds a placeholder so the first apply can bring Cloud Run up.
    // Boot rather than crash-loop, but say so loudly: every Gemini call will
    // fail until a real key is added as a new secret version.
    process.stderr.write(
      JSON.stringify({
        severity: 'ERROR',
        message:
          'Gemini API key is still the Terraform placeholder. Add the real key: ' +
          'gcloud secrets versions add synap-gemini-api-key --data-file=-',
      }) + '\n',
    );
  }

  cachedSecrets = { geminiApiKey, sessionSigningKey: key };
  return cachedSecrets;
}

/** Test seam: inject secrets without touching Secret Manager. */
export function setSecretsForTest(secrets: Secrets | null): void {
  cachedSecrets = secrets;
}
