/* Add missing declared indexes without modifying existing indexes or Terraform state. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');

function block(source, start) {
  let depth = 1, end = start;
  while (depth && end < source.length) {
    const char = source[end++];
    if (char === '{') depth++;
    if (char === '}') depth--;
  }
  if (depth) throw Error('Unclosed index declaration');
  return source.slice(start, end - 1);
}
function declarations(source) {
  // Only this repository's literal index declarations are supported. Refuse
  // expressions rather than guessing which production resource they describe.
  const result = [];
  for (const match of source.matchAll(/resource "google_firestore_index" "(\w+)"\s*\{/g)) {
    const body = block(source, match.index + match[0].length);
    const collection = body.match(/collection\s*=\s*"(\w+)"/)?.[1];
    if (!['recordings', 'conversations', 'followUps'].includes(collection) || !/query_scope\s*=\s*"COLLECTION"/.test(body))
      throw Error('Unsupported collection or scope: ' + match[1]);
    const fields = [...body.matchAll(/\bfields\s*\{/g)].map(field => {
      const config = block(body, field.index + field[0].length);
      const fieldPath = config.match(/field_path\s*=\s*"(\w+)"/)?.[1];
      const order = config.match(/\border\s*=\s*"(ASCENDING|DESCENDING)"/)?.[1];
      const arrayConfig = config.match(/array_config\s*=\s*"(CONTAINS)"/)?.[1];
      const dimension = config.match(/dimension\s*=\s*(\d+)/)?.[1];
      if (!fieldPath || [order, arrayConfig, dimension].filter(Boolean).length !== 1) throw Error('Unsupported index field');
      return { fieldPath, ...(order ? { order } : arrayConfig ? { arrayConfig } : { vectorConfig: { dimension: Number(dimension), flat: {} } }) };
    });
    if (!fields.length) throw Error('Empty index declaration');
    result.push({ address: 'google_firestore_index.' + match[1], collection, queryScope: 'COLLECTION', fields });
  }
  if (!result.length) throw Error('No index declarations found');
  return result;
}
function signature(index) {
  const collection = index.collection || index.name?.match(/\/collectionGroups\/([^/]+)\/indexes\//)?.[1];
  return JSON.stringify([collection, index.queryScope, index.apiScope || 'ANY_API',
    (index.fields || []).filter(field => field.fieldPath !== '__name__').map(field => [
      field.fieldPath, field.order || null, field.arrayConfig || null,
      field.vectorConfig ? [Number(field.vectorConfig.dimension), Object.hasOwn(field.vectorConfig, 'flat')] : null,
    ])]);
}
function plan(expected, existing) {
  return expected.map(index => ({ ...index, existing: existing.find(candidate => signature(candidate) === signature(index)) || null }));
}
function createArgs(index, project) {
  const fields = index.fields.map(field => ({ 'field-path': field.fieldPath,
    ...(field.order ? { order: field.order.toLowerCase() } : field.arrayConfig ? { 'array-config': 'contains' } : { 'vector-config': field.vectorConfig }) }));
  return ['firestore', 'indexes', 'composite', 'create', '--project=' + project, '--database=(default)',
    '--collection-group=' + index.collection, '--query-scope=collection', '--field-config=' + JSON.stringify(fields), '--async', '--quiet', '--format=json'];
}
async function run() {
  const project = process.env.PROJECT_ID;
  if (!project || !/^[a-z][a-z0-9-]+$/.test(project)) throw Error('Set PROJECT_ID');
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Only --apply is supported');
  const expected = declarations(fs.readFileSync(path.join(__dirname, 'terraform/main.tf'), 'utf8'));
  const call = args => JSON.parse(execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 }));
  const list = () => call(['firestore', 'indexes', 'composite', 'list', '--project=' + project, '--database=(default)', '--format=json']);
  const report = rows => {
    for (const row of rows) console.log(row.address + ': ' + (row.existing?.state || 'MISSING'));
  };
  let rows = plan(expected, list()); // Fail on access denial before any writes.
  report(rows);
  if (!process.argv.includes('--apply')) return;
  for (const row of rows.filter(row => !row.existing)) {
    console.log('Creating ' + row.address);
    try { call(createArgs(row, project)); }
    catch (error) {
      if (!plan([row], list())[0].existing) throw error;
    }
  }
  const deadline = Date.now() + 10 * 60 * 1000;
  do {
    rows = plan(expected, list());
    if (rows.every(row => row.existing?.state === 'READY')) {
      const mappings = rows.map(row => row.address + ' = ' + row.existing.name).join('\n');
      console.log('All declared indexes are READY. Terraform adoption mappings:\n' + mappings);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Firestore indexes ready; import matching resources into the existing state if absent:\n\n```text\n' + mappings + '\n```\n');
      return;
    }
    if (rows.some(row => row.existing?.state === 'NEEDS_REPAIR')) throw Error('An existing index needs operator repair');
    report(rows);
    await wait(15000);
  } while (Date.now() < deadline);
  throw Error('Indexes are still building; rerun the check after they become READY');
}
if (require.main === module) run().catch(error => {
  console.error(String(error.stderr || error.message));
  process.exitCode = 1;
});
module.exports = { declarations, signature, plan, createArgs };
