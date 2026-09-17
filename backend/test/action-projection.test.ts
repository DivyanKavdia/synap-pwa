import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDek, openJson, sealJson } from '../src/crypto/envelope.js';
import { projectActions } from '../src/pipeline/action-projection.js';
import { validateMemory } from '../src/gemini/memory.js';
import { addSelfSample, selfSimilarity } from '../src/speaker/profile.js';
import type {
  FollowUpContent,
  FollowUpDoc,
  RecordingDoc,
  StructuredMemory,
} from '../src/store/types.js';

const uid = 'u',
  dek = generateDek(),
  recording = { recordingId: 'r', startedAt: '2026-09-17T05:00:00Z' } as RecordingDoc;
const binding = (id: string) => ({ uid, scope: `followUp/${id}`, field: 'task' });
function memory(): StructuredMemory {
  return {
    schema_version: 2,
    title: 'Plan',
    executive_summary: 'Plan agreed',
    key_points: [],
    people: [],
    topics: [],
    conversations: [
      {
        title: 'Launch',
        summary: 'Plan',
        start_ms: 0,
        end_ms: 10000,
        people: [],
        topics: [],
        decisions: [],
        follow_ups: [],
        action_items: [
          {
            task: 'Send the plan',
            owner: 'self',
            due_date: '2026-09-18',
            evidence: 'I will send the plan tomorrow',
            due_evidence: 'tomorrow',
            start_ms: 1000,
            end_ms: 3000,
          },
        ],
      },
    ],
  };
}
const project = (m: StructuredMemory, old: FollowUpDoc[] = []) =>
  projectActions(uid, dek, recording, m, old, new Map(), ['c'], '2026-09-17T06:00:00Z');
test('speaker and deadline corrections preserve task identity and completed status', () => {
  const m = memory(),
    first = project(m)[0]!;
  first.state = 'done';
  m.conversations[0]!.action_items[0]!.owner = 'Riya';
  m.conversations[0]!.action_items[0]!.due_date = '2026-09-20';
  const result = project(m, [first]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.followUpId, first.followUpId);
  assert.equal(result[0]!.state, 'done');
  assert.equal(result[0]!.ownerType, 'other');
  assert.equal(result[0]!.dueDate, '2026-09-20');
});
test('human task, owner, deadline, pin and check-in survive rewritten extraction with the same evidence', () => {
  const m = memory(),
    first = project(m)[0]!;
  first.sealedTask = sealJson(
    dek,
    {
      task: 'Email the reviewed plan',
      sourceTask: 'Send the plan',
      owner: 'self',
      kind: 'commitment',
    },
    binding(first.followUpId),
  );
  Object.assign(first, {
    userEdited: { task: true, owner: true, dueDate: true },
    dueDate: '2026-09-23',
    checkInDate: '2026-09-19',
    pinned: true,
  });
  m.conversations[0]!.action_items[0]!.task = 'Deliver the launch plan';
  m.conversations[0]!.action_items[0]!.owner = 'Riya';
  const result = project(m, [first])[0]!,
    content = openJson<FollowUpContent>(dek, result.sealedTask, binding(first.followUpId));
  assert.equal(result.followUpId, first.followUpId);
  assert.equal(content.task, 'Email the reviewed plan');
  assert.equal(content.owner, 'self');
  assert.equal(result.dueDate, '2026-09-23');
  assert.equal(result.checkInDate, '2026-09-19');
  assert.equal(result.pinned, true);
  assert.throws(() =>
    openJson(dek, result.sealedTask, { ...binding(first.followUpId), uid: 'someone-else' }),
  );
  m.conversations[0]!.action_items = [];
  assert.equal(
    project(m, [result])[0]!.sourceMissing,
    true,
    'disappeared source requires review, not silent deletion',
  );
});
test('identical task text with different dates survives repeated projections separately', () => {
  const m = memory(),
    a = m.conversations[0]!.action_items[0]!;
  m.conversations[0]!.action_items.push({ ...a, due_date: '2026-09-25' });
  const first = project(m);
  first[1]!.state = 'done';
  const next = project(m, first);
  assert.equal(next.length, 2);
  assert.deepEqual(
    next.map((item) => item.followUpId),
    first.map((item) => item.followUpId),
  );
  assert.deepEqual(
    next.map((item) => item.state),
    ['open', 'done'],
  );
});
test('anonymous I stays unassigned and unsupported deadlines do not erase the task', () => {
  const m = memory();
  m.conversations[0]!.action_items[0]!.due_evidence = 'Next month';
  const result = validateMemory(m, 10000, '[00:01] S?: I will send the plan tomorrow');
  assert.equal(result.conversations[0]!.action_items[0]!.owner, '');
  assert.equal(result.conversations[0]!.action_items[0]!.due_date, null);
  const confirmed = validateMemory(
    m,
    10000,
    '[00:01] Divyan: I will send the plan tomorrow',
    'Divyan',
  );
  assert.equal(confirmed.conversations[0]!.action_items[0]!.owner, 'self');
});
test('self references require compatible consented samples, remain bounded and retain model isolation', () => {
  const profile = {
    embedding: [1, 0],
    model: 'm',
    sampleDurationMs: 10000,
    consentVersion: 1,
    displayName: 'Divyan',
  };
  const sample = { embedding: [0.9, 0.2], model: 'm', duration_ms: 6000 };
  let result = addSelfSample(profile, sample, 'r:S1');
  assert.equal(result.references!.length, 2);
  assert.deepEqual(addSelfSample(result, sample, 'r:S1'), result);
  for (let i = 0; i < 5; i++) result = addSelfSample(result, sample, 'new-' + i);
  assert.equal(result.references!.length, 3);
  assert(selfSimilarity(result, sample.embedding, 'm') > 0.95);
  assert.equal(selfSimilarity(result, sample.embedding, 'other'), -1);
  assert.throws(() => addSelfSample(profile, { ...sample, embedding: [0, 1] }, 'wrong'), /differs/);
  assert.throws(() => addSelfSample(profile, { ...sample, model: 'new' }, 'wrong'), /model/);
});
