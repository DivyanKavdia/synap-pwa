'use strict';
const fs = require('node:fs');

// Production adoption is intentionally narrow: attach existing resources and
// add missing indexes. Runtime, IAM, queue and secret changes need their own
// explicit review instead of slipping into an infrastructure reconciliation.
function checkPlan(plan) {
  if (plan.errored || plan.complete === false) throw new Error('Terraform plan is incomplete or errored');
  const blocked = [];
  for (const change of plan.resource_changes || []) {
    const actions = change.change?.actions || [];
    if (actions.every(action => action === 'no-op' || action === 'read')) continue;
    if (actions.length === 1 && actions[0] === 'forget' && [
      'google_secret_manager_secret_version.gemini_api_key_placeholder',
      'google_secret_manager_secret_version.session_signing_key',
      'random_bytes.session_signing_key',
    ].includes(change.address)) continue;
    if (actions.length === 1 && actions[0] === 'create' && change.type === 'google_firestore_index' &&
        change.change.after?.query_scope === 'COLLECTION') continue;
    blocked.push(`${change.address}: ${actions.join(',')}`);
  }
  if (blocked.length) throw new Error(`Production adoption requires review:\n${blocked.join('\n')}`);
  return true;
}

if (require.main === module) {
  try { checkPlan(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))); console.log('Adoption plan contains only imports, preserved versions, and missing collection indexes.'); }
  catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
module.exports = { checkPlan };
