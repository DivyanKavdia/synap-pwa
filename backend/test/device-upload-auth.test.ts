import assert from 'node:assert/strict';
import test from 'node:test';
import { setSecretsForTest } from '../src/config.js';
import { issueDeviceUploadToken, verifyDeviceUploadToken } from '../src/http/auth.js';
import type { UserDoc } from '../src/store/types.js';

test('device upload tokens are short-lived and scoped to one user, device and recording', async t => {
  setSecretsForTest({
    geminiApiKey: 'fixture',
    sessionSigningKey: Buffer.alloc(32, 7),
  });
  t.after(() => setSecretsForTest(null));
  const user = { uid: 'user-1', tokenGeneration: 9 } as UserDoc;
  const recordingId = '11111111-1111-4111-8111-111111111111';
  const ticket = await issueDeviceUploadToken(user, recordingId, 'SYNAP-DEVICE');
  assert.equal(ticket.expires_in > 0 && ticket.expires_in <= 3600, true);
  const claims = await verifyDeviceUploadToken(ticket.token);
  assert.equal(claims.uid, user.uid);
  assert.equal(claims.gen, 9);
  assert.equal(claims.recordingId, recordingId);
  assert.equal(claims.deviceId, 'SYNAP-DEVICE');
  assert.equal(claims.typ, 'device-upload');
});

test('invalid device upload scopes are rejected before signing', async t => {
  setSecretsForTest({
    geminiApiKey: 'fixture',
    sessionSigningKey: Buffer.alloc(32, 8),
  });
  t.after(() => setSecretsForTest(null));
  const user = { uid: 'user-1', tokenGeneration: 1 } as UserDoc;
  await assert.rejects(issueDeviceUploadToken(user, 'not-a-recording', 'device'), /Invalid device upload scope/);
  await assert.rejects(issueDeviceUploadToken(user, '11111111-1111-4111-8111-111111111111', ''), /Invalid device upload scope/);
});
