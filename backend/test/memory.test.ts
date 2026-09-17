/**
 * The validator is the line between a memory system and a plausible-sounding
 * fiction, so it gets tested against the specific ways a model gets creative.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemory } from '../src/gemini/memory.js';
import { fallbackBrief } from '../src/pipeline/brief.js';
import type { StructuredMemory } from '../src/store/types.js';

const DURATION = 600_000; // ten minutes

function memory(overrides: Partial<StructuredMemory> = {}): StructuredMemory {
  return {
    schema_version: 1,
    title: 'Launch planning',
    executive_summary: 'The team settled the launch date.',
    key_points: ['Launch moves to Friday'],
    people: [
      { name: 'Ankit', role: 'colleague', evidence: 'introduced himself as Ankit', confidence: 0.9 },
    ],
    topics: ['launch'],
    conversations: [
      {
        title: 'Launch planning',
        summary: 'Decided to launch Friday.',
        start_ms: 0,
        end_ms: 300_000,
        people: [
          { name: 'Ankit', role: 'colleague', evidence: 'said his name', confidence: 0.9 },
        ],
        topics: ['launch'],
        decisions: [{ text: 'Launch on Friday', start_ms: 120_000, end_ms: 130_000 }],
        action_items: [
          { task: 'Send the deck', owner: 'self', due_date: '2026-09-05', start_ms: 140_000, end_ms: 150_000 },
        ],
        follow_ups: [{ text: 'Check legal approval', owner: 'Ankit', start_ms: 200_000, end_ms: 210_000 }],
      },
    ],
    ...overrides,
  };
}

test('a well-formed memory survives validation unchanged in substance', () => {
  const result = validateMemory(memory(), DURATION);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0]?.decisions.length, 1);
  assert.equal(result.conversations[0]?.action_items.length, 1);
});

test('a decision timed beyond the recording is dropped', () => {
  const input = memory();
  input.conversations[0]!.decisions.push({
    text: 'Hire a new designer',
    start_ms: 9_000_000,
    end_ms: 9_100_000,
  });
  const result = validateMemory(input, DURATION);
  assert.equal(result.conversations[0]?.decisions.length, 1);
  assert.equal(result.conversations[0]?.decisions[0]?.text, 'Launch on Friday');
});

test('an action with an unsupported owner is retained for clarification', () => {
  const input = memory();
  input.conversations[0]!.action_items.push({
    task: 'Approve the budget',
    owner: 'Priya',
    due_date: null,
    start_ms: 160_000,
    end_ms: 170_000,
  });
  const result = validateMemory(input, DURATION);
  assert.equal(result.conversations[0]?.action_items.length, 2);
  assert.equal(result.conversations[0]?.action_items[0]?.owner, 'self');
  assert.equal(result.conversations[0]?.action_items[1]?.owner, '');
});

test('an invalid due date is cleared without dropping a real task', () => {
  const input = memory();
  input.conversations[0]!.action_items = [
    { task: 'Send the deck', owner: 'self', due_date: 'next Friday', start_ms: 1, end_ms: 2 },
  ];
  assert.equal(validateMemory(input, DURATION).conversations[0]?.action_items.length, 1);
  assert.equal(validateMemory(input, DURATION).conversations[0]?.action_items[0]?.due_date, null);
});

test('a null due date is preserved rather than invented', () => {
  const input = memory();
  input.conversations[0]!.action_items = [
    { task: 'Send the deck', owner: 'self', due_date: null, start_ms: 1, end_ms: 2 },
  ];
  const result = validateMemory(input, DURATION);
  assert.equal(result.conversations[0]?.action_items[0]?.due_date, null);
});

test('a person with no supporting evidence is dropped', () => {
  const input = memory({
    people: [
      { name: 'Ankit', role: 'colleague', evidence: 'said his name', confidence: 0.9 },
      { name: 'Rahul', role: 'colleague', evidence: '', confidence: 0.4 },
    ],
  });
  const result = validateMemory(input, DURATION);
  assert.deepEqual(
    result.people.map((person) => person.name),
    ['Ankit'],
  );
});

test('a conversation whose window is inverted is dropped entirely', () => {
  const input = memory();
  input.conversations[0]!.start_ms = 400_000;
  input.conversations[0]!.end_ms = 100_000;
  assert.equal(validateMemory(input, DURATION).conversations.length, 0);
});

test('conversations are returned in chronological order', () => {
  const input = memory();
  const first = { ...input.conversations[0]!, title: 'Second', start_ms: 400_000, end_ms: 500_000 };
  input.conversations = [first, input.conversations[0]!];
  const result = validateMemory(input, DURATION);
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.title),
    ['Launch planning', 'Second'],
  );
});

test('duplicate topics are collapsed', () => {
  const result = validateMemory(memory({ topics: ['launch', 'launch', 'hiring'] }), DURATION);
  assert.deepEqual(result.topics, ['launch', 'hiring']);
});

test('an empty title falls back rather than rendering blank', () => {
  const result = validateMemory(memory({ title: '   ' }), DURATION);
  assert.equal(result.title, 'Untitled capture');
});

test('the deterministic fallback brief separates commitments from waiting-on', () => {
  const brief = fallbackBrief([{ recording_id: 'r1', memory: memory() }]);
  assert.equal(brief.commitments.length, 1);
  assert.equal(brief.commitments[0]?.text, 'Send the deck');
  assert.equal(brief.decisions.length, 1);
  assert.deepEqual(brief.people, ['Ankit']);
});

test('the fallback brief carries provenance on every item', () => {
  const brief = fallbackBrief([{ recording_id: 'r1', memory: memory() }]);
  for (const item of [...brief.decisions, ...brief.commitments, ...brief.waiting_on]) {
    assert.equal(item.recording_id, 'r1');
    assert.ok(Number.isInteger(item.start_ms));
  }
});
