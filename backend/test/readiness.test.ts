import assert from 'node:assert/strict';
import test from 'node:test';
import { type TokenPayload } from 'google-auth-library';
import { serviceIdentityMatches } from '../src/http/service-auth.js';
import { safeProbeFailure } from '../src/ops/readiness.js';
import { loadSecrets, setSecretsForTest, validateRuntimeConfiguration } from '../src/config.js';

test('operational checks require the exact verified Google service identity', () => {
  const email = 'deployer@example.iam.gserviceaccount.com';
  const payload = { sub: '123', email, email_verified: true, iss: 'https://accounts.google.com' } as TokenPayload;
  assert.equal(serviceIdentityMatches(payload, email), true);
  for (const changed of [{ email: 'other@example.com' }, { email_verified: false }, { iss: 'https://attacker.test' }, { sub: '' }])
    assert.equal(serviceIdentityMatches({ ...payload, ...changed }, email), false);
  assert.equal(serviceIdentityMatches(payload, ''), false);
  assert.equal(serviceIdentityMatches(undefined, email), false);
});

test('operational failure reports never echo raw dependency bodies or secrets', () => {
  const cause = Object.assign(new Error('API key secret and private transcript'), { code: 7 });
  assert.deepEqual(safeProbeFailure(cause), { code: 'dependency_7' });
  assert.deepEqual(safeProbeFailure(new Error('private body')), { code: 'check_failed' });
});

test('production cannot start without Cloud Tasks configuration', () => {
  assert.doesNotThrow(() => validateRuntimeConfiguration(false));
  assert.throws(() => validateRuntimeConfiguration(true), /Cloud Tasks/);
});

test('placeholder Gemini credentials fail startup before a revision can serve traffic', async () => {
  const original = process.env.SYNAP_GEMINI_API_KEY;
  try {
    setSecretsForTest(null);
    process.env.SYNAP_GEMINI_API_KEY = 'REPLACE_WITH_YOUR_GEMINI_API_KEY';
    await assert.rejects(loadSecrets(), /placeholder/);
  } finally {
    process.env.SYNAP_GEMINI_API_KEY = original;
    setSecretsForTest(null);
  }
});
