'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'memory-actions.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const library = fs.readFileSync(path.join(root, 'memory-library.js'), 'utf8');
const memoryTools = fs.readFileSync(path.join(root, 'memory-tools.js'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'workspace.css'), 'utf8');

function load(overrides = {}) {
  const opened = [];
  const events = [];
  const context = {
    console,
    Date,
    JSON,
    Error,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Set,
    Map,
    TextEncoder,
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    open: (url, target, features) => {
      opened.push({ url, target, features });
      return {};
    },
    location: { href: '' },
    SynapAuth: { isSignedIn: () => true },
    dispatchEvent: (event) => events.push(event),
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    ...overrides,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, api: context.SynapMemoryActions, opened, events };
}

function sample() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Old title',
    createdAt: '2026-09-22T08:00:00.000Z',
    processingState: 'done',
    processingStage: 'ready',
    processedAt: '2026-09-22T08:10:00.000Z',
    meeting: {
      title: 'Product unification',
      executive_summary: 'The merged sources were unified into one memory.',
      key_points: ['Use the complete merged transcript', 'Keep one source of truth'],
      topics: ['Synap', 'Memories'],
      people: [{ name: 'Alex' }],
      conversations: [
        {
          decisions: [{ text: 'Recreate after merge' }],
          action_items: [{ task: 'Ship memory actions', owner: 'self', due_date: '2026-09-23' }],
          follow_ups: [{ text: 'Verify the unified result' }],
        },
      ],
    },
  };
}

function sampleMerge() {
  return {
    merge_id: 'merge-123',
    source_recording_ids: ['source-a', 'source-b', 'source-c'],
    started_at: '2026-09-22T08:00:00.000Z',
    created_at: '2026-09-22T08:15:00.000Z',
    updated_at: '2026-09-22T08:20:00.000Z',
    transcript: '[00:00] S1: merged transcript',
    memory: sample().meeting,
  };
}

test('memory actions are loaded, cached offline and hooked into memory cards', () => {
  assert.match(html, /src="memory-actions\.js\?v=1\.0\.0-memory-actions1"/);
  assert.match(sw, /'\.\/memory-actions\.js'/);
  assert.match(library, /SynapMemoryActions\?\.decorate\(card, row\)/);
  assert.match(memoryTools, /SynapMemoryActions\?\.decorateMerged\?\.\(card, merge\)/);
  assert.match(workspace, /\.memory-actions-panel/);
  assert.match(workspace, /grid-template-columns:\s*repeat\(4,/);
});

test('structured memory share text includes unified outcomes without raw audio', () => {
  const { api } = load();
  const text = api.shareText(sample());
  assert.match(text, /^Product unification/m);
  assert.match(text, /The merged sources were unified into one memory\./);
  assert.match(text, /• Recreate after merge/);
  assert.match(text, /• Ship memory actions — self · 2026-09-23/);
  assert.match(text, /• Verify the unified result/);
  assert.match(text, /Shared from Synap · infinite memories/);
  assert.doesNotMatch(text, /raw transcript/i);
});

test('sharing is available for local structured memories but recreation requires cloud readiness', () => {
  const { api } = load();
  const cloud = sample();
  assert.equal(api.ready(cloud), true);
  assert.equal(api.canRebuild(cloud), true);

  const local = { ...cloud, localOnly: true };
  assert.equal(api.ready(local), true);
  assert.equal(api.canRebuild(local), false);

  const signedOut = load({ SynapAuth: { isSignedIn: () => false } }).api;
  assert.equal(signedOut.canRebuild(cloud), false);
});

test('WhatsApp and Gmail open user-initiated compose URLs with the memory', () => {
  const { api, opened } = load();
  api.shareWhatsApp(sample());
  api.shareGmail(sample());
  assert.equal(opened.length, 2);
  assert.match(opened[0].url, /^https:\/\/wa\.me\/\?text=/);
  assert.match(decodeURIComponent(opened[0].url), /Product unification/);
  assert.match(opened[1].url, /^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
  assert.match(decodeURIComponent(opened[1].url), /Synap memory — Product unification/);
});

test('PDF builder emits a real PDF envelope around rendered pages', () => {
  const { api } = load();
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = api.buildPdfBinary({ width: 10, height: 20, pages: [jpeg] });
  const text = Buffer.from(pdf).toString('latin1');
  assert(text.startsWith('%PDF-1.4'));
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Subtype \/Image/);
  assert.match(text, /\/Filter \/DCTDecode/);
  assert.match(text, /startxref/);
  assert(text.endsWith('%%EOF'));
  assert.match(api.safeFilename(sample()), /^synap-memory-2026-09-22-product-unification\.pdf$/);
});

test('merged memory recreation rebuilds all source transcripts and refreshes the same merge', async () => {
  const calls = [];
  const { api, events } = load({
    SynapBackend: {
      rebuildMemoryMerge: async (id) => {
        calls.push(['rebuild-merge', id]);
        return {
          merge_id: id,
          rebuilt: true,
          source_recording_ids: ['source-a', 'source-b', 'source-c'],
          retranscribed_segments: 0,
        };
      },
    },
    SynapMemoryTools: {
      refresh: async () => {
        calls.push(['refresh-merges']);
      },
    },
  });
  const record = api.fromMerge(sampleMerge());
  assert.equal(record.mergeId, 'merge-123');
  assert.equal(record.mergedSourceCount, 3);
  assert.equal(api.canRebuild(record), true);
  const status = { textContent: '' };
  const result = await api.recreate(record, status);
  assert.equal(result.retranscribed_segments, 0);
  assert.deepEqual(calls, [
    ['rebuild-merge', 'merge-123'],
    ['refresh-merges'],
  ]);
  assert.match(status.textContent, /3 source memories without retranscribing audio/);
  assert.equal(events.at(-1).type, 'synap-memory-rebuilt');
  assert.equal(events.at(-1).detail.mergeId, 'merge-123');
  assert.deepEqual(events.at(-1).detail.sourceRecordingIds, ['source-a', 'source-b', 'source-c']);
});

test('recreate uses cloud transcript-only rebuild then refreshes the same local memory', async () => {
  const calls = [];
  const { api, events } = load({
    SynapBackend: {
      rebuildMemory: async (id) => {
        calls.push(['rebuild', id]);
        return {
          rebuilt: true,
          reused_transcript_segments: 4,
          retranscribed_segments: 0,
        };
      },
    },
    SynapCloudHistory: {
      restoreRecording: async (id, force) => {
        calls.push(['restore', id, force]);
        return { updated: 1 };
      },
    },
  });
  const status = { textContent: '' };
  const result = await api.recreate(sample(), status);
  assert.equal(result.retranscribed_segments, 0);
  assert.deepEqual(calls, [
    ['rebuild', sample().id],
    ['restore', sample().id, true],
  ]);
  assert.match(status.textContent, /4 transcript segments without retranscribing audio/);
  assert.equal(events.at(-1).type, 'synap-memory-rebuilt');
  assert.equal(events.at(-1).detail.recordingId, sample().id);
});
