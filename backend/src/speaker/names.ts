import { openJson } from '../crypto/envelope.js';
import type { RecordingDoc } from '../store/types.js';

export type SpeakerNames = Record<string, string>;
const LINE = /^([ \t]*(?:\[\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\][ \t]*)?)([^:\r\n\[\]]{1,80})(:[ \t]*)/gm;

export function transcriptSpeakers(transcript: string): { label: string; excerpt: string }[] {
  const found = new Map<string, string>();
  for (const match of transcript.matchAll(LINE)) {
    const label = match[2]!.trim();
    if (!label || found.has(label)) continue;
    found.set(label, transcript.slice(match.index! + match[0].length).split(/\r?\n/, 1)[0]!.slice(0, 180));
  }
  return [...found].map(([label, excerpt]) => ({ label, excerpt }));
}

export function validateSpeakerNames(value: unknown, transcript: string): SpeakerNames {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Speaker names must be a label-to-name map.');
  const labels = new Set(transcriptSpeakers(transcript).map(({ label }) => label));
  const entries = Object.entries(value);
  const names: SpeakerNames = Object.create(null);
  for (const [label, input] of entries) {
    if (!labels.has(label)) throw new Error('A speaker label has changed. Reload the names and try again.');
    if (typeof input !== 'string' || input.length > 80 || /[:\x00-\x1f\x7f]/.test(input)) throw new Error('Use a name of up to 80 characters without colons or line breaks.');
    const name = input.trim();
    if (name && name !== label) names[label] = name;
  }
  if (Object.keys(names).length > 32) throw new Error('Name up to 32 speakers per recording.');
  return names;
}

export function applySpeakerNames(transcript: string, names: SpeakerNames): string {
  return transcript.replace(LINE, (original, prefix: string, label: string, separator: string) =>
    Object.hasOwn(names, label.trim()) ? prefix + names[label.trim()] + separator : original);
}

export function readSpeakerNames(uid: string, recording: RecordingDoc, dek: Buffer): SpeakerNames {
  return recording.sealedSpeakerNames
    ? openJson<SpeakerNames>(dek, recording.sealedSpeakerNames, { uid, scope: `recording/${recording.recordingId}`, field: 'speaker-names' })
    : recording.sealedIdentifiedSpeakers
      ? openJson<SpeakerNames>(dek,recording.sealedIdentifiedSpeakers,{uid,scope:`recording/${recording.recordingId}`,field:'identified-speakers'})
      : {};
}

export function speakerTranscriptFields(uid: string, recording: RecordingDoc, dek: Buffer, transcript?: string) {
  const names = readSpeakerNames(uid, recording, dek);
  return { speaker_names: names, ...(transcript === undefined ? {} : { raw_transcript: transcript, transcript: applySpeakerNames(transcript, names) }) };
}
