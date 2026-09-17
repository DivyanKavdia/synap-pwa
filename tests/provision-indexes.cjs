'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { declarations, plan, createArgs } = require('../infra/provision-indexes.cjs');
const source = fs.readFileSync(path.join(__dirname, '../infra/terraform/main.tf'), 'utf8');
test('index provisioning uses the declared field definitions and retains existing indexes', () => {
  const indexes = declarations(source);
  assert.equal(indexes.length, 9);
  const existing = indexes.map((index, id) => ({ ...index, name: 'projects/p/databases/(default)/collectionGroups/' + index.collection + '/indexes/' + id, state: 'READY', fields: [...index.fields, {fieldPath:'__name__',order:'ASCENDING'}] }));
  assert(plan(indexes, existing).every(row => row.existing));
  const groups = existing.map(index => ({ ...index, queryScope: 'COLLECTION_GROUP' }));
  assert(plan(indexes, groups).every(row => !row.existing), 'collection-group indexes cannot serve per-account queries');
  const wrongVector = existing.map(index => ({ ...index, fields: index.fields.map(field => field.vectorConfig ? {...field, vectorConfig:{dimension:256,flat:{}}} : field) }));
  assert.equal(plan(indexes, wrongVector).filter(row => !row.existing).length, 2);
  for (const index of indexes) {
    const args = createArgs(index, 'fixture-project');
    assert.deepEqual(args.slice(0,4), ['firestore','indexes','composite','create']);
    assert(args.includes('--query-scope=collection'));
    assert(args.includes('--async'));
    assert(!args.some(arg => /delete|update|iam|secret/.test(arg)));
  }
  assert.throws(() => declarations(source.replace('collection  = "conversations"', 'collection = "privateOther"')), /Unsupported/);
  assert.throws(() => declarations(''), /No index/);
});
