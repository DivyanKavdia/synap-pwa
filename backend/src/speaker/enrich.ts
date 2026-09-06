import { config } from '../config.js';
import type { TranscriptWord } from '../store/types.js';
import { log } from '../util/log.js';
import { cosineSimilarity, extractSpeakerSample } from './audio.js';
import { embedSpeakerAudio, speakerServiceConfigured } from './client.js';
import { readVoiceProfile } from './profile.js';

interface Candidate {
  speaker: string;
  score: number;
  model: string;
  speechMs: number;
}

export interface SelfSpeakerResult {
  words: TranscriptWord[];
  matchedSpeaker: string | null;
  score: number | null;
}

/**
 * Enrich diarization with the enrolled owner voice. This function is explicitly
 * best-effort: any model/service/profile problem returns the original words, so
 * speaker verification can never fail transcription.
 */
export async function tagSelfSpeaker(
  uid: string,
  dek: Buffer,
  audio: Buffer,
  words: TranscriptWord[],
  segmentStartMs: number,
): Promise<SelfSpeakerResult> {
  if (!speakerServiceConfigured() || words.length === 0) {
    return { words, matchedSpeaker: null, score: null };
  }

  try {
    const profile = await readVoiceProfile(uid, dek);
    if (!profile) return { words, matchedSpeaker: null, score: null };

    const speakers = [...new Set(
      words.map((word) => word.speaker).filter((speaker): speaker is string => Boolean(speaker) && speaker !== 'YOU'),
    )];
    if (speakers.length === 0) return { words, matchedSpeaker: null, score: null };

    const candidates = (await Promise.all(speakers.map(async (speaker): Promise<Candidate | null> => {
      const sample = extractSpeakerSample(
        audio,
        words,
        speaker,
        segmentStartMs,
        config.speaker.minSampleMs,
        config.speaker.maxSampleMs,
      );
      if (!sample) return null;
      const embedded = await embedSpeakerAudio(sample.wav);
      if (embedded.model !== profile.model || embedded.embedding.length !== profile.embedding.length) return null;
      return {
        speaker,
        score: cosineSimilarity(profile.embedding, embedded.embedding),
        model: embedded.model,
        speechMs: sample.speechMs,
      };
    }))).filter((candidate): candidate is Candidate => Boolean(candidate));

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1];
    if (!best || best.score < config.speaker.matchThreshold) {
      return { words, matchedSpeaker: null, score: best?.score ?? null };
    }
    if (second && best.score - second.score < config.speaker.minMatchMargin) {
      log.info('Voice profile match withheld because speaker margin was too small', {
        uid,
        best: Number(best.score.toFixed(3)),
        second: Number(second.score.toFixed(3)),
      });
      return { words, matchedSpeaker: null, score: best.score };
    }

    return {
      words: words.map((word) => word.speaker === best.speaker ? { ...word, speaker: 'YOU' } : word),
      matchedSpeaker: best.speaker,
      score: best.score,
    };
  } catch (cause) {
    log.warn('Voice profile enrichment skipped', {
      uid,
      error: (cause as Error).message,
    });
    return { words, matchedSpeaker: null, score: null };
  }
}
