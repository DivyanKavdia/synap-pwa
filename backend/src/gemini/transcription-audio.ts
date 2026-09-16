/** A disposable, pitch-preserving ASR copy. Original PCM never leaves memory here. */
import { spawn } from 'node:child_process';
import { makePcm16Wav, parsePcm16Wav } from '../speaker/audio.js';

export interface TranscriptionAudio {
  audio: Buffer;
  speed: 1 | 1.5;
  sourceDurationMs: number;
  durationMs: number;
  fallback?: 'short-window' | 'conversion-failed' | 'empty-recognition';
}

export function originalAudio(audio: Buffer): TranscriptionAudio {
  const pcm = parsePcm16Wav(audio);
  const durationMs = pcm.data.length / 32;
  return { audio, speed: 1, sourceDurationMs: durationMs, durationMs };
}

export async function prepareTranscriptionAudio(
  audio: Buffer,
  speed: 1 | 1.5,
  signal?: AbortSignal,
): Promise<TranscriptionAudio> {
  signal?.throwIfAborted();
  const original = originalAudio(audio);
  if (speed === 1) return original;
  // Keep very short utterances and the last partial window; never discard them.
  if (original.durationMs < 1000) return { ...original, fallback: 'short-window' };
  // The upload contract bounds windows to 30 s. Refuse an unbounded subprocess.
  if (audio.length > 2_000_000) return { ...original, fallback: 'conversion-failed' };
  try {
    const pcm = parsePcm16Wav(audio).data;
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-threads',
          '1',
          '-f',
          's16le',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-i',
          'pipe:0',
          '-filter_threads',
          '1',
          '-af',
          'atempo=1.5',
          '-f',
          's16le',
          '-ar',
          '16000',
          '-ac',
          '1',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );
      const chunks: Buffer[] = [];
      let bytes = 0,
        failure: Error | undefined;
      const fail = (error: Error) => {
        failure ||= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => fail(new Error('Audio preparation timed out')), 10000);
      const abort = () => fail(new Error('Audio preparation cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > pcm.length + 3200) fail(new Error('Audio preparation exceeded its bound'));
        else chunks.push(chunk);
      });
      child.on('error', (error) => {
        failure ||= error;
      });
      child.stdin.on('error', (error) => fail(error));
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure || code !== 0) reject(failure || new Error('Audio preparation failed'));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(pcm);
    });
    signal?.throwIfAborted();
    const durationMs = output.length / 32;
    // atempo has a small analysis-window tolerance, not a change in sample rate.
    if (
      !output.length ||
      output.length % 2 ||
      Math.abs(durationMs - original.durationMs / speed) > 100
    )
      throw new Error('Invalid prepared audio duration');
    return {
      audio: makePcm16Wav(output),
      speed,
      sourceDurationMs: original.durationMs,
      durationMs,
    };
  } catch {
    signal?.throwIfAborted();
    return { ...original, fallback: 'conversion-failed' };
  }
}
