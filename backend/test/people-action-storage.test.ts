/** Mutations are account-scoped and never remove or recreate source recordings. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { deletePerson, patchFollowUp, paths } from '../src/store/firestore.js';

test('deleting a person addresses only that account profile and is idempotent', async () => {
  const original = paths.people;
  const profiles = new Set(['alice/person-1', 'bob/person-1']);
  const calls: string[] = [];
  paths.people = (uid) =>
    ({
      doc: (id: string) => ({
        delete: async () => {
          calls.push(uid + '/' + id);
          profiles.delete(uid + '/' + id);
        },
      }),
    }) as unknown as ReturnType<typeof paths.people>;
  try {
    await deletePerson('alice', 'person-1');
    await deletePerson('alice', 'person-1');
    assert.deepEqual(calls, ['alice/person-1', 'alice/person-1']);
    assert.deepEqual([...profiles], ['bob/person-1']);
  } finally {
    paths.people = original;
  }
});

test('completion updates an existing task and reports a missing task without creating it', async () => {
  const original = paths.followUps;
  const writes: unknown[] = [];
  paths.followUps = (uid) =>
    ({
      doc: (id: string) => ({
        update: async (fields: unknown) => {
          if (id === 'missing') throw Object.assign(new Error('Missing'), { code: 5 });
          if (id === 'offline') throw Object.assign(new Error('Unavailable'), { code: 14 });
          writes.push({ uid, id, fields });
        },
      }),
    }) as unknown as ReturnType<typeof paths.followUps>;
  try {
    assert.equal(await patchFollowUp('alice', 'task', { state: 'done' }), true);
    assert.equal(await patchFollowUp('alice', 'task', { state: 'open' }), true);
    assert.equal(await patchFollowUp('alice', 'missing', { state: 'done' }), false);
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((value) => {
        const item = value as {
          uid: string;
          id: string;
          fields: { state: string; updatedAt: string };
        };
        assert(Number.isFinite(Date.parse(item.fields.updatedAt)));
        return [item.uid, item.id, item.fields.state];
      }),
      [
        ['alice', 'task', 'done'],
        ['alice', 'task', 'open'],
      ],
    );
    await assert.rejects(patchFollowUp('alice', 'offline', { state: 'done' }), /Unavailable/);
  } finally {
    paths.followUps = original;
  }
});
