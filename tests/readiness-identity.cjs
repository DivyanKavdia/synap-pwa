'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mintIdentity } = require('../infra/readiness-identity.cjs');

function credentials() {
  return {
    type: 'external_account',
    audience:
      '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/github/providers/synap',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    credential_source: { url: 'https://example.test/fresh-github-token' },
    service_account_impersonation_url:
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/deployer@example-project.iam.gserviceaccount.com:generateAccessToken',
  };
}

test('readiness mints each token from the refreshable WIF principal without changing deployment credentials', async () => {
  const configuration = credentials();
  const before = structuredClone(configuration);
  let calls = 0;
  const library = {
    GoogleAuth: class {
      fromJSON(source) {
        assert.equal(source.service_account_impersonation_url, undefined);
        assert.deepEqual(source.credential_source, configuration.credential_source);
        assert.equal(source.audience, configuration.audience);
        return { kind: 'federated-principal' };
      }
    },
    Impersonated: class {
      constructor(options) {
        assert.equal(options.sourceClient.kind, 'federated-principal');
        assert.equal(options.targetPrincipal, 'deployer@example-project.iam.gserviceaccount.com');
      }
      async fetchIdToken(audience, options) {
        assert.equal(audience, 'https://service.example.test');
        assert.equal(options.includeEmail, true);
        return `fresh-token-${++calls}`;
      }
    },
  };
  assert.equal(
    await mintIdentity('https://service.example.test', configuration, library),
    'fresh-token-1',
  );
  assert.equal(
    await mintIdentity('https://service.example.test', configuration, library),
    'fresh-token-2',
  );
  assert.deepEqual(configuration, before);
});

test('readiness refuses malformed identity targets and audiences before requesting credentials', async () => {
  for (const audience of ['http://service.example.test', 'https://service.example.test/path'])
    await assert.rejects(mintIdentity(audience, credentials(), {}));
  for (const mutation of [
    { type: 'service_account' },
    { service_account_impersonation_url: 'https://other.example.test/mint' },
    { service_account_impersonation_url: undefined },
  ])
    await assert.rejects(
      mintIdentity('https://service.example.test', { ...credentials(), ...mutation }, {}),
    );
});
