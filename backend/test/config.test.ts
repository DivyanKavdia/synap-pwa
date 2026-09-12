import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSecrets, setSecretsForTest } from '../src/config.js';

test('inline secrets use the same signing-key validation and cache as secret-backed configuration', async () => {
  const original = process.env.SYNAP_SESSION_SIGNING_KEY;
  try {
    setSecretsForTest(null);
    process.env.SYNAP_SESSION_SIGNING_KEY = Buffer.alloc(8, 1).toString('base64');
    await assert.rejects(loadSecrets(), /at least 32 bytes/);

    process.env.SYNAP_SESSION_SIGNING_KEY = Buffer.alloc(32, 2).toString('base64');
    const secrets = await loadSecrets();
    assert.equal(secrets.sessionSigningKey.byteLength, 32);
    assert.equal(await loadSecrets(), secrets, 'only validated secrets are cached');
  } finally {
    if (original === undefined) delete process.env.SYNAP_SESSION_SIGNING_KEY;
    else process.env.SYNAP_SESSION_SIGNING_KEY = original;
    setSecretsForTest(null);
  }
});
