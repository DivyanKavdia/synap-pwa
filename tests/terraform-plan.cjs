const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPlan } = require('../infra/check-terraform-plan.cjs');
const change = (type, actions, after = {}, address = `${type}.example`) => ({ address, type, change: { actions, after } });

test('production adoption accepts imports and missing collection indexes', () => {
  assert.equal(checkPlan({ complete: true, resource_changes: [
    change('google_cloud_run_v2_service', ['no-op']),
    change('google_firestore_index', ['create'], { query_scope: 'COLLECTION' }),
    change('google_secret_manager_secret_version', ['forget'], {}, 'google_secret_manager_secret_version.gemini_api_key_placeholder'),
  ] }), true);
});
test('production adoption blocks deletion, replacement, secret rotation, runtime, queue and IAM drift', () => {
  for (const item of [
    change('google_firestore_index', ['delete', 'create']),
    change('google_storage_bucket', ['delete']),
    change('google_secret_manager_secret_version', ['create']),
    change('google_cloud_run_v2_service', ['update']),
    change('google_cloud_tasks_queue', ['update']),
    change('google_project_iam_member', ['create']),
    change('google_firestore_index', ['create'], { query_scope: 'COLLECTION_GROUP' }),
    change('google_storage_bucket', ['forget']),
  ]) assert.throws(() => checkPlan({ resource_changes: [item] }), /requires review/);
  assert.throws(() => checkPlan({ complete: false }), /incomplete/);
});
