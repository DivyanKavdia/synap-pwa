'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ Date });
vm.runInContext(fs.readFileSync('action-state.js', 'utf8'), context);
const api = context.SynapActionState;
const now = new Date(2026, 8, 13, 23, 30);

test('action ranges follow local calendar weeks and cross month/year boundaries', () => {
  const range = (period, date = now) => Array.from(api.range(period, date));
  assert.deepEqual(range('last-week'), ['2026-08-31', '2026-09-06']);
  assert.deepEqual(range('this-week'), ['2026-09-07', '2026-09-13']);
  assert.deepEqual(range('next-week'), ['2026-09-14', '2026-09-20']);
  assert.deepEqual(range('next-month'), ['2026-09-13', '2026-10-12']);
  assert.deepEqual(range('next-week', new Date(2026, 11, 31)), ['2027-01-04', '2027-01-10']);
  // Dates around the US daylight-saving transitions remain seven calendar days.
  for (const date of [new Date(2026, 2, 8), new Date(2026, 10, 1)]) {
    const [start, end] = range('this-week', date).map((day) => new Date(day + 'T12:00:00'));
    assert.equal(start.getDay(), 1);
    assert.equal(end.getDay(), 0);
  }
});

test('due dates take priority over when a task was recorded', () => {
  const task = { due: '2026-09-15', recordedAt: '2026-08-01T12:00:00' };
  assert(api.matches(task, 'next-week', now));
  assert(!api.matches(task, 'last-week', now));
  assert(!api.matches(task, 'overdue', now));
  assert(api.matches({ ...task, due: '2026-09-12' }, 'overdue', now));
  assert(api.matches({ ...task, due: '2026-09-13' }, 'today', now));
});

test('undated actions have no invented future deadline and malformed dates are undated', () => {
  const task = { recordedAt: new Date(2026, 8, 13).toISOString() };
  assert(api.matches(task, 'today', now));
  for (const period of ['next-week', 'next-month', 'overdue'])
    assert(!api.matches(task, period, now));
  for (const due of ['', 'tomorrow', '2026-02-30', '2026-13-01']) {
    assert(api.matches({ ...task, due }, 'undated', now));
  }
  assert(!api.matches({ due: '2026-10-13' }, 'next-month', now));
  assert(api.matches({ due: '2026-10-12' }, 'next-month', now));
});

test('local completion distinguishes task sources and account scopes', () => {
  const task = { r: { id: 'one' }, startMs: 1000, text: 'Send proposal', owner: 'Me' };
  const key = api.key(task);
  task.r.actionStates = { alice: { [key]: 'done' } };
  assert.equal(api.state(task, 'alice'), 'done');
  assert.equal(api.state(task, 'bob'), 'open');
  assert.equal(api.state({ ...task, startMs: 2000 }, 'alice'), 'open');
  assert.equal(
    api.state({ ...task, r: { id: 'two', actionStates: task.r.actionStates } }, 'alice'),
    'open',
  );
});
