import { openJson, sealJson, type Binding, type Sealed } from '../crypto/envelope.js';
import { cosineSimilarity } from './audio.js';
import type { SpeakerEmbeddingResult } from './client.js';
import { log } from '../util/log.js';
import * as db from '../store/firestore.js';

export interface VoiceProfilePayload {
  embedding: number[];
  model: string;
  sampleDurationMs: number;
  consentVersion: number;
  displayName?: string;
  references?: { embedding: number[]; sourceId: string }[];
}

interface VoiceProfileDoc {
  profileId: 'self';
  sealedProfile: Sealed;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceProfileView {
  enrolled: boolean;
  model: string | null;
  sampleDurationMs: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  displayName: string | null;
  sampleCount?: number;
}

const profileRef = (uid: string) =>
  db.firestore().collection('users').doc(uid).collection('voiceProfiles').doc('self');

function binding(uid: string): Binding {
  return { uid, scope: 'voiceProfile/self', field: 'profile' };
}

export async function readVoiceProfile(uid: string, dek: Buffer): Promise<VoiceProfilePayload | null> {
  const snapshot = await profileRef(uid).get();
  if (!snapshot.exists) return null;
  const doc = snapshot.data() as VoiceProfileDoc;
  return openJson<VoiceProfilePayload>(dek, doc.sealedProfile, binding(uid));
}

export async function voiceProfileStatus(uid: string, dek: Buffer): Promise<VoiceProfileView> {
  const snapshot = await profileRef(uid).get();
  if (!snapshot.exists) {
    return { enrolled: false, model: null, sampleDurationMs: null, createdAt: null, updatedAt: null, displayName: null };
  }
  const doc = snapshot.data() as VoiceProfileDoc;
  let profile: VoiceProfilePayload;
  try {
    profile = openJson<VoiceProfilePayload>(dek, doc.sealedProfile, binding(uid));
  } catch (cause) {
    // An unreadable voice profile must not 500 the whole settings screen. It is
    // re-enrollable from the app, unlike a transcript, so reporting "not
    // enrolled" is both honest and the state the user can act on.
    log.error('Sealed record failed to open', {
      kind: 'voiceProfile', uid, error: (cause as Error).message,
    });
    return { enrolled: false, model: null, sampleDurationMs: null, createdAt: null, updatedAt: null, displayName: null };
  }
  return {
    enrolled: true,
    model: profile.model,
    sampleDurationMs: profile.sampleDurationMs,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    displayName: profile.displayName || null,
    sampleCount: profile.references?.length || 1,
  };
}

export async function saveVoiceProfile(
  uid: string,
  dek: Buffer,
  profile: VoiceProfilePayload,
): Promise<VoiceProfileView> {
  const ref = profileRef(uid);
  const existing = await ref.get();
  if (existing.exists && profile.displayName === undefined) {
    const previous = openJson<VoiceProfilePayload>(dek, (existing.data() as VoiceProfileDoc).sealedProfile, binding(uid));
    if (previous.displayName) profile = { ...profile, displayName: previous.displayName };
  }
  const now = new Date().toISOString();
  const createdAt = existing.exists ? String((existing.data() as VoiceProfileDoc).createdAt) : now;
  const doc: VoiceProfileDoc = {
    profileId: 'self',
    sealedProfile: sealJson(dek, profile, binding(uid)),
    createdAt,
    updatedAt: now,
  };
  await ref.set(doc);
  return {
    enrolled: true,
    model: profile.model,
    sampleDurationMs: profile.sampleDurationMs,
    createdAt,
    updatedAt: now,
    displayName: profile.displayName || null,
    sampleCount: profile.references?.length || 1,
  };
}

export async function renameVoiceProfile(uid: string, dek: Buffer, displayName: string): Promise<boolean> {
  return db.firestore().runTransaction(async tx => {
    const ref = profileRef(uid), snapshot = await tx.get(ref);
    if (!snapshot.exists) return false;
    const doc = snapshot.data() as VoiceProfileDoc;
    const profile = openJson<VoiceProfilePayload>(dek, doc.sealedProfile, binding(uid));
    tx.update(ref, { sealedProfile: sealJson(dek, { ...profile, displayName }, binding(uid)), updatedAt: new Date().toISOString() });
    return true;
  });
}

export async function deleteVoiceProfile(uid: string): Promise<boolean> {
  const ref = profileRef(uid);
  const snapshot = await ref.get();
  if (!snapshot.exists) return false;
  await ref.delete();
  return true;
}

export class SelfSampleError extends Error {}
export function addSelfSample(existing: VoiceProfilePayload, sample: SpeakerEmbeddingResult, sourceId: string): VoiceProfilePayload {
  if (existing.model !== sample.model) throw new SelfSampleError('The voice model changed. Re-enroll your voice first.');
  const references = existing.references?.length ? existing.references : [{ embedding: existing.embedding, sourceId: 'enrollment' }];
  if (references.some(reference => reference.sourceId === sourceId)) return existing;
  if (references.every(reference => cosineSimilarity(reference.embedding, sample.embedding) < .78))
    throw new SelfSampleError('This sample differs from your saved voice. Check the speaker or re-enroll with clearer speech.');
  return { ...existing, references: [...references, { embedding: sample.embedding, sourceId }].slice(-3) };
}
export function selfSimilarity(profile: VoiceProfilePayload, embedding: number[], model: string): number {
  if (profile.model !== model) return -1;
  const references = profile.references?.length ? profile.references.map(item => item.embedding) : [profile.embedding];
  const scores = references.map(reference => cosineSimilarity(reference, embedding)).sort((a,b) => b-a).slice(0,2);
  return scores.reduce((a,b) => a+b,0) / scores.length;
}
/** Only an explicitly confirmed self label can contribute an enrollment sample. */
export async function saveSelfSample(uid: string, dek: Buffer, sample: SpeakerEmbeddingResult, recordingId: string, label: string, revision: string, name: string): Promise<void> {
  await db.firestore().runTransaction(async tx => {
    const record = await tx.get(db.paths.recording(uid, recordingId));
    if (!record.exists || record.data()?.state !== 'ready' || record.data()?.updatedAt !== revision || record.data()?.selfSpeakerLabel !== label)
      throw new SelfSampleError('This recording changed. Save your speaker identity again before enrolling.');
    const ref = profileRef(uid), snapshot = await tx.get(ref), now = new Date().toISOString();
    const previous = snapshot.exists ? openJson<VoiceProfilePayload>(dek, (snapshot.data() as VoiceProfileDoc).sealedProfile, binding(uid)) : null;
    const sourceId = recordingId + ':' + label;
    const payload: VoiceProfilePayload = previous ? addSelfSample(previous, sample, sourceId) : {
      embedding: sample.embedding, model: sample.model, sampleDurationMs: sample.duration_ms, consentVersion: 1,
      references: [{ embedding: sample.embedding, sourceId }],
    };
    payload.displayName = name;
    tx.set(ref, { profileId: 'self', sealedProfile: sealJson(dek, payload, binding(uid)),
      createdAt: snapshot.exists ? (snapshot.data() as VoiceProfileDoc).createdAt : now, updatedAt: now });
  });
}
