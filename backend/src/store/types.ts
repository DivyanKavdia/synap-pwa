/**
 * Persistence shapes.
 *
 * Naming convention: any field prefixed `sealed` holds a `Sealed` envelope and
 * is unreadable without the user's DEK. Everything else is deliberately
 * plaintext because the system has to filter, sort or count on it — dates,
 * states, offsets, digests. Nothing in the plaintext set is conversation
 * content; the worst it reveals is that a recording happened and how long it
 * ran. That boundary is the whole security model, so adding a plaintext field
 * here is a decision worth arguing about.
 */

import type { Sealed } from '../crypto/envelope.js';
import type { WrappedKey } from '../crypto/keyring.js';

export type ProcessingState =
  | 'created'
  | 'uploading'
  | 'uploaded'
  | 'transcribing'
  | 'understanding'
  | 'indexing'
  | 'ready'
  | 'failed';

export interface UserDoc {
  uid: string;
  /** Google `sub`. Stable across email changes, unlike the address. */
  googleSubject: string;
  /** Sealed: email and display name are personal data. */
  sealedProfile: Sealed;
  key: WrappedKey;
  createdAt: string;
  lastSeenAt: string;
  /** Bumped on sign-out-everywhere; older refresh tokens stop validating. */
  tokenGeneration: number;
  audioRetentionDays: number;
}

export interface UserProfile {
  email: string;
  name: string;
  picture: string;
}

export interface RecordingDoc {
  recordingId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  sampleRate: number;
  channels: number;
  encoding: string;
  language: string;
  /** Local day key (YYYY-MM-DD) in the user's zone, for the daily brief. */
  day: string;
  timezone: string;
  continuousGroupId: string | null;
  continuousPart: number;
  segmentCount: number;
  uploadedSegments: number;
  state: ProcessingState;
  progress: number;
  errorCode: string | null;
  retryable: boolean;
  /** Sealed `StructuredMemory`. Present once understanding completes. */
  sealedMemory: Sealed | null;
  /** Sealed full transcript text, joined across segments. */
  sealedTranscript: Sealed | null;
  /** User-confirmed names for this recording's original speaker labels. */
  sealedSpeakerNames?: Sealed | null;
  /** Automatic matches are separate from source labels and explicit user overrides. */
  sealedIdentifiedSpeakers?: Sealed | null;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentDoc {
  sealedSpeakerMap?: Sealed | null;
  transcriptionReview?: { attempted: boolean; annotationsComplete: boolean };
  index: number;
  startMs: number;
  endMs: number;
  sha256: string;
  bytes: number;
  /** GCS object path. The object body is itself sealed. */
  storagePath: string | null;
  state: 'accepted' | 'transcribed' | 'failed';
  /** Sealed transcript text for this segment. */
  sealedTranscript: Sealed | null;
  /** Sealed word annotations (speaker + offsets) from the ASR model. */
  sealedWords: Sealed | null;
  language: string | null;
  uploadedAt: string;
  transcribedAt: string | null;
}

export interface HighlightDoc {
  highlightId: string;
  offsetMs: number;
  createdAt: string;
  source: 'pwa' | 'pendant';
  sealedNote: Sealed | null;
}

/** One real-world conversation. This is the unit Ask Synap retrieves over. */
export interface ConversationDoc {
  conversationId: string;
  recordingId: string;
  day: string;
  startMs: number;
  endMs: number;
  startedAt: string;
  /** Sealed `{title, summary, quote}`. */
  sealedContent: Sealed;
  /**
   * Retrieval vector. Derived, not sealed — Firestore has to compute distances
   * server-side. Embeddings leak coarse topical similarity, so the tradeoff is
   * documented rather than hidden. Set SYNAP_DISABLE_VECTOR_INDEX=1 to fall
   * back to sealed-only storage with keyword retrieval.
   */
  embedding: number[] | null;
  personIds: string[];
  /** Lowercased topic slugs, used as cheap prefilters before vector search. */
  topicKeys: string[];
  highlightCount: number;
  createdAt: string;
}

export interface PersonDoc {
  personId: string;
  /** HMAC of the normalized name under the user's DEK — lets us dedupe without storing names in the clear. */
  nameKey: string;
  /**
   * Every name key this person has been seen under, including nameKey itself.
   *
   * A rename would otherwise undo itself: correcting "Ankit" to "Ankit Sharma"
   * moves the key, the next extraction still hears "Ankit", finds nothing, and
   * creates a second person. Confirmed names are also fed back to the model, so
   * the drift runs in both directions. Matching on the alias set keeps one
   * person whichever name the transcript happens to use.
   *
   * Optional because documents written before this existed have only nameKey.
   */
  aliasKeys?: string[];
  sealedProfile: Sealed;
  confirmedByUser: boolean;
  firstSeenAt: string;
  lastInteractionAt: string;
  conversationCount: number;
}

export interface FollowUpDoc {
  followUpId: string;
  sealedTask: Sealed;
  ownerType: 'self' | 'other';
  counterpartyPersonId: string | null;
  dueDate: string | null;
  state: 'open' | 'done' | 'dismissed';
  recordingId: string;
  conversationId: string | null;
  startMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface DayDoc {
  day: string;
  sealedBrief: Sealed;
  recordingIds: string[];
  generatedAt: string;
}

export interface JobDoc {
  jobId: string;
  recordingId: string;
  stage: 'transcribe' | 'understand' | 'index' | 'brief';
  state: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Model output shapes (sealed before they are written)
// ---------------------------------------------------------------------------

export interface MemoryPerson {
  name: string;
  role: string;
  evidence: string;
  confidence: number;
}

export interface MemoryAction {
  task: string;
  owner: string;
  due_date: string | null;
  start_ms: number;
  end_ms: number;
}

export interface MemoryConversation {
  title: string;
  summary: string;
  start_ms: number;
  end_ms: number;
  people: MemoryPerson[];
  topics: string[];
  decisions: { text: string; start_ms: number; end_ms: number }[];
  action_items: MemoryAction[];
  follow_ups: { text: string; owner: string; start_ms: number; end_ms: number }[];
}

export interface StructuredMemory {
  schema_version: number;
  title: string;
  executive_summary: string;
  key_points: string[];
  people: MemoryPerson[];
  topics: string[];
  conversations: MemoryConversation[];
}

export interface DailyBrief {
  narrative: string;
  decisions: { text: string; recording_id: string; start_ms: number }[];
  commitments: { text: string; due_date: string | null; recording_id: string; start_ms: number }[];
  waiting_on: { text: string; person: string; recording_id: string; start_ms: number }[];
  unresolved: string[];
  highlights: { text: string; recording_id: string; start_ms: number }[];
  people: string[];
  topics: string[];
}

export interface TranscriptWord {
  text: string;
  speaker: string | null;
  start_ms: number;
  end_ms: number;
}
