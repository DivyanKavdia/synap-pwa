'use strict';

// Use the action's refreshable WIF source to mint an ID token immediately before
// a readiness check. The existing workloadIdentityUser grant permits this; the
// deployment service account does not need TokenCreator permission on itself.
async function mintIdentity(audience, credentials, library) {
  const origin = new URL(audience);
  if (origin.protocol !== 'https:' || origin.origin !== audience)
    throw new Error('Expected an HTTPS service origin');
  const target =
    /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com):generateAccessToken$/.exec(
      credentials.service_account_impersonation_url || '',
    );
  if (credentials.type !== 'external_account' || !target)
    throw new Error('Expected the deployment action WIF credentials');

  const { GoogleAuth, Impersonated } =
    library || require('../backend/node_modules/google-auth-library');
  const source = { ...credentials };
  delete source.service_account_impersonation_url;
  delete source.service_account_impersonation;
  // Authenticate as the existing federated principal for this single mint.
  // Do not modify the credential file gcloud uses for deployment and rollback.
  const sourceClient = new GoogleAuth().fromJSON(source);
  const client = new Impersonated({
    sourceClient,
    targetPrincipal: decodeURIComponent(target[1]),
    targetScopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const token = await client.fetchIdToken(audience, { includeEmail: true });
  if (typeof token !== 'string' || !token.trim()) throw new Error('Empty identity token');
  return token;
}

if (require.main === module) {
  Promise.resolve()
    .then(async () => {
      const fs = require('node:fs');
      const credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_GHA_CREDS_PATH, 'utf8'));
      process.stdout.write(await mintIdentity(process.argv[2], credentials));
    })
    .catch(() => {
      // Auth library errors can contain request headers; never print them.
      console.error('Unable to mint readiness identity. Check the deployment WIF configuration.');
      process.exitCode = 1;
    });
}

module.exports = { mintIdentity };
