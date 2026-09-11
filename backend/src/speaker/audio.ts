import type { TranscriptWord } from '../store/types.js';

interface ParsedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Buffer;
}

function ascii(buffer: Buffer, offset: number, length: number): string {
  return buffer.toString('ascii', offset, offset + length);
}

export function parsePcm16Wav(buffer: Buffer): ParsedWav {
  if (buffer.length < 44 || ascii(buffer, 0, 4) !== 'RIFF' || ascii(buffer, 8, 4) !== 'WAVE') {
    throw new Error('Speaker verification requires a WAV recording');
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let format = 0;
  let data: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const id = ascii(buffer, offset, 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(buffer.length, start + size);
    if (id === 'fmt ' && end - start >= 16) {
      format = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === 'data') {
      data = buffer.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }

  if (!data || format !== 1 || channels !== 1 || bitsPerSample !== 16 || sampleRate !== 16000) {
    throw new Error('Speaker verification requires mono 16-bit PCM at 16 kHz');
  }
  return { sampleRate, channels, bitsPerSample, data };
}

export function makePcm16Wav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface Span {
  startMs: number;
  endMs: number;
}

function speakerSpans(
  words: TranscriptWord[],
  speaker: string,
  segmentStartMs: number,
  durationMs: number,
): Span[] {
  const spans: Span[] = [];
  for (const word of words.slice().sort((a,b)=>a.start_ms-b.start_ms)) {
    if (word.speaker !== speaker) continue;
    const startMs = Math.max(0, word.start_ms - segmentStartMs - 80);
    const endMs = Math.min(durationMs, word.end_ms - segmentStartMs + 80);
    if (endMs <= startMs) continue;
    const previous = spans[spans.length - 1];
    if (previous && startMs <= previous.endMs + 140) previous.endMs = Math.max(previous.endMs, endMs);
    else spans.push({ startMs, endMs });
  }
  // Mixed voices must not enter an identity sample, including the padding
  // around a turn boundary. Unknown-speaker words are competing evidence too.
  let clean = spans;
  for(const word of words) {
    if(word.speaker===speaker)continue;
    const start=word.start_ms-segmentStartMs-80,end=word.end_ms-segmentStartMs+80;
    clean=clean.flatMap(span=>{
      if(end<=span.startMs || start>=span.endMs)return [span];
      return [{startMs:span.startMs,endMs:Math.min(start,span.endMs)},
        {startMs:Math.max(end,span.startMs),endMs:span.endMs}].filter(part=>part.endMs>part.startMs);
    });
  }
  return clean;
}

export interface SpeakerSample {
  wav: Buffer;
  speechMs: number;
}

/**
 * Build one compact speaker sample from diarized word spans. We concatenate only
 * that speaker's regions, preserving a tiny silence between regions so abrupt
 * cuts do not dominate the embedding. Source audio is never modified.
 */
export function extractSpeakerSample(
  wav: Buffer,
  words: TranscriptWord[],
  speaker: string,
  segmentStartMs: number,
  minSampleMs: number,
  maxSampleMs: number,
): SpeakerSample | null {
  const parsed = parsePcm16Wav(wav);
  const bytesPerMs = (parsed.sampleRate * 2) / 1000;
  const durationMs = parsed.data.length / bytesPerMs;
  const spans = speakerSpans(words, speaker, segmentStartMs, durationMs);
  const chunks: Buffer[] = [];
  let speechMs = 0;
  const silence = Buffer.alloc(Math.round(50 * bytesPerMs));

  for (const span of spans) {
    if (speechMs >= maxSampleMs) break;
    const remaining = maxSampleMs - speechMs;
    const spanMs = Math.min(span.endMs - span.startMs, remaining);
    const start = Math.max(0, Math.floor(span.startMs * bytesPerMs / 2) * 2);
    const end = Math.min(parsed.data.length, Math.floor((span.startMs + spanMs) * bytesPerMs / 2) * 2);
    if (end <= start) continue;
    if (chunks.length) chunks.push(silence);
    chunks.push(parsed.data.subarray(start, end));
    speechMs += (end - start) / bytesPerMs;
  }

  if (speechMs < minSampleMs || chunks.length === 0) return null;
  return { wav: makePcm16Wav(Buffer.concat(chunks), parsed.sampleRate), speechMs: Math.round(speechMs) };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  if (aa === 0 || bb === 0) return -1;
  return dot / Math.sqrt(aa * bb);
}
