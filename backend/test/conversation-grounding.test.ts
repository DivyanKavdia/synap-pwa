import assert from 'node:assert/strict';
import test from 'node:test';
import { toSpeakerLines } from '../src/gemini/transcribe.js';
import { validateMemory } from '../src/gemini/memory.js';
import type { StructuredMemory } from '../src/store/types.js';

test('segment timestamp prefixes do not disable complete diarization', () => {
  const rendered = toSpeakerLines(
    [
      { text: 'Hello', speaker: 'S1', start_ms: 30_000, end_ms: 30_200 },
      { text: 'world', speaker: 'S1', start_ms: 30_200, end_ms: 30_400 },
    ],
    '[00:30] S?: Hello world',
  );
  assert.equal(rendered, '[00:30] S1: Hello world');
});

test('partial annotations preserve the segment-level timestamped fallback', () => {
  const flat = '[02:00] S?: This is the complete segment transcript and it keeps going.';
  const rendered = toSpeakerLines(
    [{ text: 'This', speaker: 'S1', start_ms: 120_000, end_ms: 120_200 }],
    flat,
  );
  assert.equal(rendered, flat);
});

test('participant and mentioned-person lists stay separate and grounded', () => {
  const memory = {
    schema_version: 2,
    title: 'Call',
    executive_summary: 'Discussed delivery.',
    key_points: [],
    people: [
      { name: 'Akshay', role: 'participant', evidence: 'Akshay introduced himself', confidence: 0.95 },
      { name: 'Ramesh', role: 'colleague', evidence: 'Ramesh was discussed by name', confidence: 0.8 },
    ],
    topics: ['delivery'],
    conversations: [{
      title: 'Delivery discussion',
      summary: 'Discussed delivery dependencies.',
      start_ms: 120_000,
      end_ms: 240_000,
      people: [],
      participants: ['Akshay', 'Unknown Person'],
      mentioned_people: ['Ramesh', 'Akshay', 'Another Unknown'],
      topics: ['delivery'],
      decisions: [],
      action_items: [],
      follow_ups: [],
    }],
  } as unknown as StructuredMemory;

  const result = validateMemory(memory, 600_000);
  const conversation = result.conversations[0] as typeof result.conversations[0] & {
    participants?: string[];
    mentioned_people?: string[];
  };
  assert.deepEqual(conversation.participants, ['Akshay']);
  assert.deepEqual(conversation.mentioned_people, ['Ramesh']);
  assert.equal(result.schema_version, 2);
});
