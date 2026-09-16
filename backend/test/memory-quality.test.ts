import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMemory, validateMemory } from '../src/gemini/memory.js';
import type { StructuredMemory } from '../src/store/types.js';

const transcript =
  '[00:00.000] S1: I am Priya. The prototype passed.\n[00:05.000] S1: We agreed to run the pilot. I will send the plan.\n[00:10.000] S2: Someone still needs to check the invoice.';
function memory(): StructuredMemory {
  return {
    schema_version: 2,
    title: 'Pilot review',
    executive_summary: 'The prototype passed; a pilot was agreed.',
    key_points: [],
    topics: ['pilot'],
    people: [{ name: 'Priya', role: 'participant', evidence: 'I am Priya.', confidence: 0.95 }],
    conversations: [
      {
        title: 'Pilot review',
        summary: 'Pilot agreed.',
        start_ms: 0,
        end_ms: 15000,
        people: [{ name: 'Priya', role: 'participant', evidence: 'I am Priya.', confidence: 0.95 }],
        participants: ['Priya'],
        mentioned_people: [],
        topics: ['pilot'],
        outcomes: [
          {
            text: 'Prototype passed',
            evidence: 'The prototype passed.',
            start_ms: 0,
            end_ms: 5000,
          },
        ],
        decisions: [
          {
            text: 'Run the pilot',
            evidence: 'We agreed to run the pilot.',
            start_ms: 5000,
            end_ms: 10000,
          },
        ],
        action_items: [
          {
            task: 'Send the plan',
            kind: 'commitment',
            evidence: 'I will send the plan.',
            owner: 'Priya',
            due_date: null,
            start_ms: 5000,
            end_ms: 10000,
          },
        ],
        follow_ups: [{ text: 'Check the invoice', owner: '', start_ms: 10000, end_ms: 15000 }],
      },
    ],
  };
}

test('memory extraction uses the upgraded structured model without resending audio and returns distinct outcomes/actions', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.equal(body.generation_config.thinking_level, 'high');
    assert.equal(typeof body.input, 'string');
    assert(body.input.includes(transcript));
    assert(body.input.includes('Asia/Kolkata'));
    return new Response(
      JSON.stringify({
        status: 'completed',
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(memory()) }] },
        ],
      }),
    );
  });
  const result = await extractMemory({
    transcript,
    durationMs: 15000,
    highlightOffsetsMs: [],
    knownPeople: [],
    language: 'en',
    day: '2026-09-16',
    timezone: 'Asia/Kolkata',
  });
  assert.equal(calls, 1);
  assert.equal(result.conversations[0]?.outcomes?.[0]?.text, 'Prototype passed');
  assert.equal(result.conversations[0]?.action_items[0]?.due_date, null);
  assert.equal(result.conversations[0]?.follow_ups[0]?.owner, '');
});

test('unsupported people, outcomes and commitments are rejected; unassigned follow-ups and grounded evidence survive', () => {
  const input = memory(),
    c = input.conversations[0]!;
  input.people.push({
    name: 'Invented person',
    role: 'participant',
    evidence: 'I am the chief executive.',
    confidence: 1,
  });
  c.participants!.push('Invented person');
  c.people.push(input.people[1]!);
  c.outcomes!.push({
    text: 'Deal signed',
    evidence: 'The deal is signed.',
    start_ms: 0,
    end_ms: 2000,
  });
  c.action_items.push({
    task: 'Transfer money',
    kind: 'commitment',
    evidence: 'I will transfer money.',
    owner: 'Priya',
    due_date: null,
    start_ms: 0,
    end_ms: 2000,
  });
  c.action_items.push({ ...c.action_items[0]! });
  c.follow_ups[0]!.owner = 'Invented person';
  const result = validateMemory(input, 15000, transcript),
    conversation = result.conversations[0]!;
  assert.deepEqual(
    result.people.map((p) => p.name),
    ['Priya'],
  );
  assert.deepEqual(conversation.participants, ['Priya']);
  assert.deepEqual(
    conversation.people.map((p) => p.name),
    ['Priya'],
  );
  assert.equal(conversation.outcomes?.length, 1);
  assert.equal(conversation.action_items.length, 1);
  assert.equal(conversation.follow_ups[0]?.text, 'Check the invoice');
  assert.equal(conversation.follow_ups[0]?.owner, '');
});

test('source-language quotes retain Hindi evidence and normalize typography without rewriting source text', () => {
  const input = memory();
  input.people = [
    { name: 'प्रिया', role: 'participant', evidence: 'मैं प्रिया हूँ।', confidence: 0.9 },
  ];
  input.conversations[0]!.outcomes = [
    { text: 'भुगतान पूरा हुआ', evidence: 'भुगतान पूरा हुआ।', start_ms: 0, end_ms: 3000 },
  ];
  const source = '[00:00.000] S1: मैं प्रिया हूँ। भुगतान पूरा हुआ।';
  const result = validateMemory(input, 15000, source);
  assert.equal(result.people[0]?.name, 'प्रिया');
  assert.equal(result.conversations[0]?.outcomes?.length, 1);
});
