import type { SegmentDoc } from '../store/types.js';

/** A count alone cannot detect a missing middle window replaced by a later one. */
export function requireCompleteSegments(segments: SegmentDoc[], expected: number): SegmentDoc[] {
  if (!Number.isSafeInteger(expected) || expected < 1 || segments.length !== expected) {
    throw new Error(
      `Recording upload is incomplete: expected ${expected} audio windows, received ${segments.length}`,
    );
  }
  const ordered = segments.slice().sort((a, b) => a.index - b.index);
  for (let index = 0; index < ordered.length; index++) {
    const segment = ordered[index]!;
    if (segment.index !== index || (!segment.storagePath && !segment.sealedTranscript)) {
      throw new Error(`Recording upload is incomplete: audio window ${index} is missing`);
    }
  }
  return ordered;
}

export function hasTranscription(segment: SegmentDoc): boolean {
  return Boolean(
    segment.sealedTranscript && segment.sealedWords && segment.state === 'transcribed',
  );
}

/** Join all workers before failing, so a failed stage cannot keep publishing progress. */
export async function transcribeRecordingSegments(
  segments: SegmentDoc[],
  expected: number,
  transcribe: (segment: SegmentDoc) => Promise<SegmentDoc>,
  progress: (done: number, total: number) => Promise<void>,
  needsTranscription: (segment: SegmentDoc) => boolean = segment => !hasTranscription(segment),
): Promise<SegmentDoc[]> {
  const ordered = requireCompleteSegments(segments, expected);
  const pending = ordered.filter(needsTranscription);
  let done = ordered.length - pending.length;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (!failure) {
      const segment = pending.shift();
      if (!segment) return;
      try {
        const completed = await transcribe(segment);
        if (!hasTranscription(completed))
          throw new Error(`Audio window ${segment.index} has no completed transcript`);
        ordered[segment.index] = completed;
        done++;
        if (!failure) await progress(done, ordered.length);
      } catch (error) {
        failure ||= error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return ordered;
}
