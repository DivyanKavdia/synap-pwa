import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sealJson, openJson, type Sealed } from '../src/crypto/envelope.js';

/**
 * One record whose AES-GCM tag does not verify used to 500 /v1/people,
 * /v1/follow-ups and /v1/voice-profile, because each decrypted inside .map().
 * These assert the shape the handlers now rely on: a tampered record throws,
 * and skipping it leaves every readable record intact.
 */
test('a record sealed under a different key fails to authenticate', () => {
  const dek = randomBytes(32);
  const other = randomBytes(32);
  const place = { uid: 'u1', scope: 'person/p1', field: 'profile' };
  const sealed = sealJson(dek, { name: 'Ankit' }, place);

  assert.equal(openJson<{ name: string }>(dek, sealed, place).name, 'Ankit');
  assert.throws(() => openJson(other, sealed, place), /authenticate|Unsupported state/i);
});

test('a record opened under the wrong binding fails to authenticate', () => {
  const dek = randomBytes(32);
  const sealed = sealJson(dek, { name: 'Ankit' }, { uid: 'u1', scope: 'person/p1', field: 'profile' });

  // Same key, same ciphertext, different place: exactly the failure mode a
  // changed personId would produce.
  assert.throws(
    () => openJson(dek, sealed, { uid: 'u1', scope: 'person/p2', field: 'profile' }),
    /authenticate|Unsupported state/i,
  );
});

test('skipping one unreadable record preserves the rest of the list', () => {
  const dek = randomBytes(32);
  const place = (id: string) => ({ uid: 'u1', scope: `person/${id}`, field: 'profile' });
  const records: { id: string; sealed: Sealed }[] = [
    { id: 'p1', sealed: sealJson(dek, { name: 'Ankit' }, place('p1')) },
    { id: 'p2', sealed: sealJson(randomBytes(32), { name: 'Broken' }, place('p2')) },
    { id: 'p3', sealed: sealJson(dek, { name: 'Priya' }, place('p3')) },
  ];

  const skipped: string[] = [];
  const names = records.flatMap((record) => {
    try {
      return openJson<{ name: string }>(dek, record.sealed, place(record.id)).name;
    } catch {
      skipped.push(record.id);
      return [];
    }
  });

  assert.deepEqual(names, ['Ankit', 'Priya'], 'readable records still reach the user');
  assert.deepEqual(skipped, ['p2'], 'and the unreadable one is identified, not silently dropped');
});

test('mixed success in one request proves the key is fine and the binding is not', () => {
  // Every record in a request is opened with the same unwrapped DEK, so the
  // count of successes is the whole diagnosis. This is the logic behind the
  // "Sealed reads failed in one request" verdict.
  const verdict = (opened: number, failed: number) =>
    !failed ? 'ok' : opened > 0 ? 'per-record binding mismatch' : 'no record opened with this key';

  assert.equal(verdict(12, 0), 'ok');
  assert.equal(verdict(12, 20), 'per-record binding mismatch', 'same key opened twelve of them');
  assert.equal(verdict(0, 20), 'no record opened with this key', 'nothing opened: suspect the key');
});
