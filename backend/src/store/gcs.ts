/**
 * Audio object storage.
 *
 * Segments land in a single bucket with uniform bucket-level access, CMEK as
 * the bucket default, and a lifecycle rule that deletes raw audio after the
 * user's retention window. On top of Google's own encryption the object body is
 * already sealed with the user's DEK before it reaches this layer, so the
 * bucket holds no readable audio even to someone holding storage.admin.
 *
 * Object naming embeds the uid as the first path segment. Combined with IAM
 * conditions on the service account this makes cross-user reads structurally
 * awkward rather than merely forbidden.
 */

import { Storage, type Bucket } from '@google-cloud/storage';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { Sealed } from '../crypto/envelope.js';

let storage: Storage | null = null;

function bucket(): Bucket {
  storage ??= new Storage({ projectId: config.projectId });
  return storage.bucket(config.storage.audioBucket);
}

export function segmentPath(uid: string, recordingId: string, index: number): string {
  // Every attempt has a separate object. An unaccepted retry cannot overwrite
  // the bytes already referenced by Firestore. Old stored paths remain readable.
  return `audio/${uid}/${recordingId}/${String(index).padStart(6, '0')}-${randomUUID()}.seg`;
}

/**
 * Sealed audio is stored as a small JSON envelope rather than raw ciphertext so
 * the IV and auth tag travel with the object and no separate index is needed to
 * decrypt it.
 */
export async function writeSealedSegment(
  path: string,
  sealed: Sealed,
  metadata: Record<string, string>,
): Promise<void> {
  const file = bucket().file(path);
  await file.save(Buffer.from(JSON.stringify(sealed), 'utf8'), {
    resumable: false,
    contentType: 'application/vnd.synap.sealed+json',
    metadata: {
      cacheControl: 'private, no-store',
      metadata,
    },
  });
}

export async function readSealedSegment(path: string): Promise<Sealed | null> {
  const file = bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return JSON.parse(contents.toString('utf8')) as Sealed;
}

export async function deleteSegment(path: string): Promise<void> {
  await bucket()
    .file(path)
    .delete({ ignoreNotFound: true });
}

/** Drop every audio object for a recording — used by retention and account delete. */
export async function deleteRecordingAudio(uid: string, recordingId: string): Promise<void> {
  await bucket().deleteFiles({ prefix: `audio/${uid}/${recordingId}/`, force: true });
}

export async function deleteUserAudio(uid: string): Promise<void> {
  await bucket().deleteFiles({ prefix: `audio/${uid}/`, force: true });
}
