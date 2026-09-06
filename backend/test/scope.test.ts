/**
 * Scope filtering moved out of the Firestore query and into memory, because a
 * vector index can only be prefixed by equality filters and Ask Synap scopes by
 * date range and array membership. That makes this the only thing enforcing a
 * requested scope, so it gets tested directly.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesScope } from '../src/store/firestore.js';
import type { ConversationDoc } from '../src/store/types.js';

function conversation(overrides: Partial<ConversationDoc> = {}): ConversationDoc {
  return {
    conversationId: 'c1',
    recordingId: 'r1',
    day: '2026-09-04',
    startMs: 0,
    endMs: 60_000,
    startedAt: '2026-09-04T10:00:00.000Z',
    sealedContent: { v: 1, iv: '', ct: '', tag: '' },
    embedding: null,
    personIds: ['p-ankit'],
    topicKeys: ['launch'],
    highlightCount: 0,
    createdAt: '2026-09-04T10:00:00.000Z',
    ...overrides,
  };
}

test('an empty scope matches everything', () => {
  assert.equal(matchesScope(conversation(), {}), true);
});

test('a day before the window is excluded', () => {
  assert.equal(matchesScope(conversation({ day: '2026-09-01' }), { from: '2026-09-03' }), false);
});

test('a day after the window is excluded', () => {
  assert.equal(matchesScope(conversation({ day: '2026-09-09' }), { to: '2026-09-05' }), false);
});

test('a day inside the window is kept', () => {
  assert.equal(matchesScope(conversation(), { from: '2026-09-01', to: '2026-09-30' }), true);
});

test('person scope keeps a conversation that includes any requested person', () => {
  assert.equal(matchesScope(conversation(), { personIds: ['p-other', 'p-ankit'] }), true);
});

test('person scope drops a conversation with none of them', () => {
  assert.equal(matchesScope(conversation(), { personIds: ['p-other'] }), false);
});

test('topic scope behaves the same way', () => {
  assert.equal(matchesScope(conversation(), { topicKeys: ['launch'] }), true);
  assert.equal(matchesScope(conversation(), { topicKeys: ['hiring'] }), false);
});

test('a conversation with no people cannot satisfy a person scope', () => {
  assert.equal(matchesScope(conversation({ personIds: [] }), { personIds: ['p-ankit'] }), false);
});

test('scope dimensions combine as AND', () => {
  const scope = { from: '2026-09-01', to: '2026-09-30', personIds: ['p-ankit'], topicKeys: ['hiring'] };
  // Day and person match, topic does not.
  assert.equal(matchesScope(conversation(), scope), false);
});
