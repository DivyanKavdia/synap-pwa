import { GoogleAuth } from 'google-auth-library';
import { config } from '../config.js';

export interface SpeakerEmbeddingResult {
  embedding: number[];
  model: string;
  duration_ms: number;
}

let idTokenClientPromise: ReturnType<GoogleAuth['getIdTokenClient']> | null = null;

export function speakerServiceConfigured(): boolean {
  return Boolean(config.speaker.serviceUrl);
}

function validate(result: unknown): SpeakerEmbeddingResult {
  const value = result as Partial<SpeakerEmbeddingResult> | null;
  if (!value || !Array.isArray(value.embedding) || value.embedding.length < 32) {
    throw new Error('Speaker service returned an invalid embedding');
  }
  if (!value.embedding.every((item) => Number.isFinite(item))) {
    throw new Error('Speaker service returned a non-finite embedding');
  }
  if (!value.model || !Number.isFinite(value.duration_ms)) {
    throw new Error('Speaker service returned incomplete metadata');
  }
  return {
    embedding: value.embedding,
    model: String(value.model),
    duration_ms: Number(value.duration_ms),
  };
}

async function requestWithFetch(url: string, audio: Buffer, signal: AbortSignal): Promise<SpeakerEmbeddingResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: audio,
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data as { detail?: string } | null)?.detail || `speaker service HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return validate(data);
}

async function requestWithOidc(url: string, audio: Buffer, signal: AbortSignal, timeoutMs: number): Promise<SpeakerEmbeddingResult> {
  if (!idTokenClientPromise) {
    const auth = new GoogleAuth();
    const pending = auth.getIdTokenClient(config.speaker.serviceUrl);
    idTokenClientPromise = pending;
    void pending.catch(() => { if (idTokenClientPromise === pending) idTokenClientPromise = null; });
  }
  const client = await idTokenClientPromise;
  signal.throwIfAborted();
  const response = await client.request<SpeakerEmbeddingResult>({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    data: audio,
    timeout: timeoutMs,
    signal,
    retry: false,
  });
  return validate(response.data);
}

/**
 * The speaker service receives audio only long enough to compute an embedding.
 * No audio persistence belongs in this client or in the service contract.
 */
export async function embedSpeakerAudio(audio: Buffer, options: { timeoutMs?: number } = {}): Promise<SpeakerEmbeddingResult> {
  if (!speakerServiceConfigured()) throw new Error('Speaker verification is not configured');
  const url = `${config.speaker.serviceUrl}/embed`;
  const timeoutMs = options.timeoutMs ?? config.speaker.requestTimeoutMs;
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error('The voice service took too long to respond. Please try again.'), { code: 'speaker_service_timeout' });
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      // Retry credential discovery after a stalled or failed token request.
      idTokenClientPromise = null;
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      config.speaker.authMode === 'none'
        ? requestWithFetch(url, audio, controller.signal)
        : requestWithOidc(url, audio, controller.signal, timeoutMs),
      deadline,
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}
