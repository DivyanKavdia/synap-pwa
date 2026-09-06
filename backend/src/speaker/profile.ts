import { openJson, sealJson, type Binding, type Sealed } from '../crypto/envelope.js';
import * as db from '../store/firestore.js';

export interface VoiceProfilePayload {
  embedding: number[];
  model: string;
  sampleDurationMs: number;
  consentVersion: number;
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
    return { enrolled: false, model: null, sampleDurationMs: null, createdAt: null, updatedAt: null };
  }
  const doc = snapshot.data() as VoiceProfileDoc;
  const profile = openJson<VoiceProfilePayload>(dek, doc.sealedProfile, binding(uid));
  return {
    enrolled: true,
    model: profile.model,
    sampleDurationMs: profile.sampleDurationMs,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function saveVoiceProfile(
  uid: string,
  dek: Buffer,
  profile: VoiceProfilePayload,
): Promise<VoiceProfileView> {
  const ref = profileRef(uid);
  const existing = await ref.get();
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
  };
}

export async function deleteVoiceProfile(uid: string): Promise<boolean> {
  const ref = profileRef(uid);
  const snapshot = await ref.get();
  if (!snapshot.exists) return false;
  await ref.delete();
  return true;
}
