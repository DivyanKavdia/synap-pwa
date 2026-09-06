/**
 * Renaming a person has to survive the next recording.
 *
 * The failure this guards is quiet and delayed: a correction is saved, the user
 * sees it, and then a recording days later re-hears the original name, matches
 * nothing, and creates a second person — so the correction appears to have been
 * ignored. The alias set is what keeps both spellings pointing at one person,
 * and it is pure set algebra, so it is tested directly.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeAliasKeys } from '../src/util/ids.js';

test('a rename keeps the old key matchable', () => {
  // The transcript will still say "Ankit" next week. That has to find the
  // person the user renamed rather than mint a second one.
  assert.deepEqual(mergeAliasKeys(undefined, 'key-ankit', 'key-ankit-sharma'), [
    'key-ankit',
    'key-ankit-sharma',
  ]);
});

test('reprocessing the same recording does not grow the alias list', () => {
  // upsertPeople runs on every recording and on every retry; an array that grew
  // each time would eventually hit Firestore's document size limit.
  const first = mergeAliasKeys(undefined, 'key-a', 'key-a');
  const second = mergeAliasKeys(first, 'key-a', 'key-a');
  assert.deepEqual(first, ['key-a']);
  assert.deepEqual(second, ['key-a']);
});

test('aliases accumulate across successive renames', () => {
  const afterFirst = mergeAliasKeys(undefined, 'key-a', 'key-b');
  const afterSecond = mergeAliasKeys(afterFirst, 'key-b', 'key-c');
  assert.deepEqual(afterSecond, ['key-a', 'key-b', 'key-c']);
});

test('blank and missing keys never enter the alias set', () => {
  // An empty string in an array-contains query would match indiscriminately,
  // merging unrelated people into whichever document it hit first.
  assert.deepEqual(mergeAliasKeys(['', null, undefined], '', 'key-real'), ['key-real']);
});

test('a person written before aliases existed still gets a usable set', () => {
  assert.deepEqual(mergeAliasKeys(undefined, 'legacy-key', 'legacy-key'), ['legacy-key']);
});

test('order is stable, so an unchanged person is not rewritten on every pass', () => {
  const existing = ['key-a', 'key-b'];
  assert.deepEqual(mergeAliasKeys(existing, 'key-a', 'key-a'), existing);
});
