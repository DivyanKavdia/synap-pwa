import type { TranscriptWord } from '../store/types.js';
import { cosineSimilarity } from './audio.js';
import type { SpeakerEmbeddingResult } from './client.js';

type Voice = Pick<SpeakerEmbeddingResult, 'embedding' | 'model'>;
type Anchor = Voice & { label: string };

/** ASR labels are local to one request. Only acoustic evidence can link windows. */
export class RecordingSpeakers {
  private anchors: Anchor[] = [];
  constructor(private threshold = .80, private margin = .10) {}

  async mapWindow(index: number, words: TranscriptWord[], embed?: (speaker: string) => Promise<Voice | null>): Promise<Record<string, string>> {
    const speakers = [...new Set(words.map(word => word.speaker).filter((speaker): speaker is string => Boolean(speaker) && speaker !== 'S?' && speaker !== 'YOU'))];
    const mapping: Record<string, string> = Object.create(null);
    const used = new Set<string>();
    const added: Anchor[] = [];
    for (const [ordinal, speaker] of speakers.entries()) {
      let voice: Voice | null = null;
      try { voice = await embed?.(speaker) || null; } catch { /* Keep a distinct label if acoustic evidence is unavailable. */ }
      const ranked = voice ? this.anchors.filter(anchor => anchor.model === voice!.model)
        .map(anchor => ({ anchor, score: cosineSimilarity(anchor.embedding, voice!.embedding) }))
        .sort((a,b) => b.score-a.score) : [];
      const best = ranked[0], second = ranked[1];
      const matched = best && !used.has(best.anchor.label) && best.score >= this.threshold && (!second || best.score-second.score >= this.margin);
      const label = matched ? best.anchor.label : `S${index+1}.${ordinal+1}`;
      mapping[speaker] = label; used.add(label);
      // Keep fixed reference voices, avoiding gradual drift through bad matches.
      if (voice && !matched && this.anchors.length+added.length < 64) added.push({ ...voice, label });
    }
    this.anchors.push(...added);
    return mapping;
  }
}

export function labelWords(words: TranscriptWord[], mapping: Record<string,string>): TranscriptWord[] {
  return words.map(word => word.speaker && Object.hasOwn(mapping,word.speaker) ? {...word,speaker:mapping[word.speaker]!} : word);
}
