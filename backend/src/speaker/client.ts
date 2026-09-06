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
    throw new Error(message);
  }
  return validate(data);
}

async function requestWithOidc(url: string, audio: Buffer): Promise<SpeakerEmbeddingResult> {
  if (!idTokenClientPromise) {
    const auth = new GoogleAuth();
    idTokenClientPromise = auth.getIdTokenClient(config.speaker.serviceUrl);
  }
  const client = await idTokenClientPromise;
  const response = await client.request<SpeakerEmbeddingResult>({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    data: audio,
    timeout: config.speaker.requestTimeoutMs,
  });
  return validate(response.data);
}

/**
 * The speaker service receives audio only long enough to compute an embedding.
 * No audio persistence belongs in this client or in the service contract.
 */
export async function embedSpeakerAudio(audio: Buffer): Promise<SpeakerEmbeddingResult> {
  if (!speakerServiceConfigured()) throw new Error('Speaker verification is not configured');
  const url = `${config.speaker.serviceUrl}/embed`;
  if (config.speaker.authMode === 'none') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.speaker.requestTimeoutMs);
    try {
      return await requestWithFetch(url, audio, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
  return requestWithOidc(url, audio);
}
