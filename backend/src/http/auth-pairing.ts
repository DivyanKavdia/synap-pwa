import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DocumentData } from '@google-cloud/firestore';
import { firestore } from '../store/firestore.js';

const COLLECTION = 'authPairings';
export const PAIRING_TTL_MS = 5 * 60 * 1000;

interface PairingDoc {
  secretHash: string;
  state: 'pending' | 'approved' | 'consumed';
  uid?: string;
  createdAt: string;
  expiresAt: string;
  expireAt: Date;
  approvedAt?: string;
  consumedAt?: string;
}

export type PairingClaim =
  | { status: 'pending' }
  | { status: 'approved'; uid: string }
  | { status: 'expired' }
  | { status: 'consumed' }
  | { status: 'invalid_secret' }
  | { status: 'missing' };

function collection() {
  return firestore().collection(COLLECTION);
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function secretsEqual(expectedHash: string, secret: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isExpired(data: PairingDoc): boolean {
  return Date.parse(data.expiresAt) <= Date.now();
}

function asPairing(data: DocumentData | undefined): PairingDoc | null {
  if (!data) return null;
  return data as PairingDoc;
}

/** Create a short-lived pairing transaction. The claim secret never leaves the
 * originating browser; only the random transaction id is sent to Safari. */
export async function createPairing(): Promise<{
  pairId: string;
  pairSecret: string;
  expiresIn: number;
}> {
  const pairId = randomBytes(18).toString('base64url');
  const pairSecret = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + PAIRING_TTL_MS);
  const doc: PairingDoc = {
    secretHash: hashSecret(pairSecret),
    state: 'pending',
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    // Firestore TTL can clean this collection asynchronously. We still enforce
    // expiry in every transaction because TTL deletion is intentionally not immediate.
    expireAt: expires,
  };
  await collection().doc(pairId).create(doc);
  return { pairId, pairSecret, expiresIn: Math.floor(PAIRING_TTL_MS / 1000) };
}

/** Bind a Google-authenticated Synap user to a pending transaction. Repeated
 * approval by the same Safari page is harmless and never changes the user. */
export async function approvePairing(pairId: string, uid: string): Promise<'approved' | 'expired' | 'missing' | 'consumed'> {
  const ref = collection().doc(pairId);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const data = asPairing(snapshot.data());
    if (!snapshot.exists || !data) return 'missing';
    if (isExpired(data)) {
      tx.delete(ref);
      return 'expired';
    }
    if (data.state === 'consumed') return 'consumed';
    if (data.state === 'approved') return 'approved';
    tx.update(ref, {
      state: 'approved',
      uid,
      approvedAt: new Date().toISOString(),
    });
    return 'approved';
  });
}

/** Atomically consume an approved transaction. No Google credential or Synap
 * token is stored in Firestore; the backend issues the session only after this
 * one-time claim succeeds. */
export async function claimPairing(pairId: string, pairSecret: string): Promise<PairingClaim> {
  const ref = collection().doc(pairId);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const data = asPairing(snapshot.data());
    if (!snapshot.exists || !data) return { status: 'missing' } as const;
    if (isExpired(data)) {
      tx.delete(ref);
      return { status: 'expired' } as const;
    }
    if (!secretsEqual(data.secretHash, pairSecret)) return { status: 'invalid_secret' } as const;
    if (data.state === 'pending') return { status: 'pending' } as const;
    if (data.state === 'consumed') return { status: 'consumed' } as const;
    if (!data.uid) return { status: 'missing' } as const;

    tx.update(ref, {
      state: 'consumed',
      consumedAt: new Date().toISOString(),
    });
    return { status: 'approved', uid: data.uid } as const;
  });
}
