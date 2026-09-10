/**
 * Materialize the best available transcript from durable 30-second windows.
 *
 * A recording-level transcript is a convenience snapshot. Segment transcripts
 * are the durable evidence because every successfully transcribed window is
 * sealed independently. Older clients could cache a non-empty but incomplete
 * recording transcript forever; this helper verifies that the snapshot covers
 * every available window before trusting it.
 */
import { openText } from '../crypto/envelope.js';
import * as db from '../store/firestore.js';
import type { RecordingDoc, SegmentDoc } from '../store/types.js';
import { binding } from './process.js';

export interface MaterializedTranscript {
  text: string;
  source: 'recording' | 'segments' | 'none';
  segmentCount: number;
  transcriptSegments: number;
  complete: boolean;
}

function comparable(value: string): string {
  return String(value || '')
    // Presentation prefixes differ between the full diarized transcript and the
    // segment fallback. Compare words, not the synthetic provenance label.
    .replace(/^\s*\[\d{2}:\d{2}(?::\d{2})?\]\s+(?:S\?|S\d+|[^:\n]{1,40}):\s*/gm, '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function chooseTranscript(stored: string, windows: string[]): { text: string; source: 'recording' | 'segments' | 'none' } {
  const cleanStored = String(stored || '').trim();
  const cleanWindows = windows.map((value) => String(value || '').trim());
  const joined = cleanWindows.filter(Boolean).join('\n').trim();

  if (!cleanStored && !joined) return { text: '', source: 'none' };
  if (!joined) return { text: cleanStored, source: cleanStored ? 'recording' : 'none' };
  if (!cleanStored) return { text: joined, source: 'segments' };

  const haystack = comparable(cleanStored);
  const coversEveryWindow = cleanWindows.every((window) => {
    const needle = comparable(window);
    return !needle || haystack.includes(needle);
  });

  return coversEveryWindow
    ? { text: cleanStored, source: 'recording' }
    : { text: joined, source: 'segments' };
}

export async function materializeTranscript(
  uid: string,
  recording: RecordingDoc,
  dek: Buffer,
  suppliedSegments?: SegmentDoc[],
): Promise<MaterializedTranscript> {
  const segments = (suppliedSegments ?? await db.listSegments(uid, recording.recordingId))
    .slice()
    .sort((a, b) => a.index - b.index);

  const windows: string[] = [];
  let transcriptSegments = 0;
  for (const segment of segments) {
    if (!segment.sealedTranscript) {
      windows.push('');
      continue;
    }
    try {
      const value = openText(
        dek,
        segment.sealedTranscript,
        binding(uid, `recording/${recording.recordingId}/segment/${segment.index}`, 'transcript'),
      );
      windows.push(value);
      transcriptSegments += 1;
    } catch {
      windows.push('');
    }
  }

  let stored = '';
  if (recording.sealedTranscript) {
    try {
      stored = openText(
        dek,
        recording.sealedTranscript,
        binding(uid, `recording/${recording.recordingId}`, 'transcript'),
      );
    } catch {
      stored = '';
    }
  }

  const selected = chooseTranscript(stored, windows);
  return {
    ...selected,
    segmentCount: segments.length,
    transcriptSegments,
    complete: segments.length > 0 && transcriptSegments === segments.length,
  };
}
