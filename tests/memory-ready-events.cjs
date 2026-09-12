'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('memory readiness ignores pending records and distinguishes later completed revisions', () => {
  const events = [];
  const context = {
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    dispatchEvent: (event) => events.push(event),
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'memory-ready-events.js'), 'utf8'),
    context,
  );
  const { emit } = context.SynapMemoryReadyEvents;
  assert.equal(emit({ id: 'r1', processingStage: 'summarizing' }), false);
  const recording = { id: 'r1', processingState: 'done', processedAt: '2026-09-12T00:00:00Z' };
  assert.equal(emit(recording), true);
  assert.equal(emit(recording), false);
  assert.equal(
    emit({ ...recording, processedAt: '2026-09-12T00:01:00Z', restoredFromCloud: true }),
    true,
  );
  assert.equal(events.length, 2);
  assert.equal(events[1].detail.source, 'cloud');
});
