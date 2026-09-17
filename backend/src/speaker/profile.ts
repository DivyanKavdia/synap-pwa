import { openJson, sealJson, type Binding, type Sealed } from '../crypto/envelope.js';
import * as db from '../store/firestore.js';

export interface VoiceProfilePayload {
  embedding: number[];
  model: string;
  sampleDurationMs: number;
  consentVersion: number;
  displayName?: string;
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
  const profile = openJson<VoiceProfilePayload>(dek, doc.sealedProfile, binding(uid));
  return {
    enrolled: true,
    model: profile.model,
    sampleDurationMs: profile.sampleDurationMs,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    displayName: profile.displayName || null,
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
