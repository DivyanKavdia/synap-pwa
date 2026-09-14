'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { windowFrames, explainWords, splitMJPEG, filterMedia } = require('../chakshu-store.js');
test('gallery search combines titles, notes and descriptions with kind and favourite filters', () => {
  const rows = [
    {
      id: 'photo',
      kind: 'image',
      name: 'Station sign',
      notes: 'Return platform',
      favourite: true,
      descriptions: [{ text: 'Train to Mumbai' }],
    },
    { id: 'video', kind: 'video', name: 'Mumbai walk', notes: 'Near station' },
    { id: 'old', kind: 'image' },
  ];
  const ids = (options) => filterMedia(rows, options).map((r) => r.id);
  assert.deepEqual(ids({ query: '  STATION Mumbai ' }), ['photo', 'video']);
  assert.deepEqual(ids({ query: 'return mumbai', kind: 'image', favourites: true }), ['photo']);
  assert.deepEqual(ids({ kind: 'video', favourites: true }), []);
  assert.deepEqual(ids({ query: '<script>' }), []);
  assert.deepEqual(ids({}), ['photo', 'video', 'old']);
});
const { decode, Client } = require('../chakshu-transfer.js');
test('explain uses only the closest frame and at most two neighbours on each side', () => {
  const frames = Array.from({ length: 100 }, (_, i) => ({ atMs: i * 500, index: i }));
  assert.deepEqual(
    windowFrames(frames, 10300).map((f) => f.index),
    [19, 20, 21, 22, 23],
  );
  assert.deepEqual(
    windowFrames(frames, 0).map((f) => f.index),
    [0, 1, 2],
  );
  assert.deepEqual(windowFrames(frames, 999999), []);
  assert.deepEqual(windowFrames(frames, NaN), []);
  assert(windowFrames(frames, 3000, 100).length <= 5);
  assert.deepEqual(windowFrames([{ atMs: 0 }, { atMs: 30000 }], 15000), []);
});
test('voice triggers require an explain word with a real audio timestamp', () => {
  assert.deepEqual(
    explainWords([
      { text: 'explain', start_ms: 1200 },
      { text: 'EXPLAIN!', start_ms: 3600 },
      { text: 'explained', start_ms: 4000 },
      { text: 'explain', start_ms: NaN },
      { text: 'explain', start_ms: -4 },
    ]),
    [1200, 3600],
  );
});
test('silent MJPEG parses into separate timestamped JPEGs and rejects truncated captures', async () => {
  const bytes = Uint8Array.from([255, 216, 1, 2, 255, 217, 255, 216, 3, 4, 255, 217]);
  const frames = splitMJPEG(bytes, [50, 700]);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].atMs, 700);
  assert.equal(frames[0].blob.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await frames[0].blob.arrayBuffer()), bytes.slice(0, 6));
  assert.throws(() => splitMJPEG(bytes.slice(0, -1)), /incomplete/);
});
function response(id, total, offset, payload = [], state = 1) {
  const v = new DataView(new ArrayBuffer(16 + payload.length));
  v.setUint8(0, 0xcb);
  v.setUint8(1, 1);
  v.setUint8(2, state);
  v.setUint32(4, id, true);
  v.setUint32(8, total, true);
  v.setUint32(12, offset, true);
  new Uint8Array(v.buffer).set(payload, 16);
  return v;
}
test('first camera request waits through empty, uninitialized and stale worker replies', async () => {
  const source = new Uint8Array([255, 216, 1, 2, 255, 217]);
  let last, reads = 0, captures = 0;
  const initial = [new DataView(new ArrayBuffer(0)), new DataView(new ArrayBuffer(16)), response(0, 0, 0)];
  const client = new Client({
    queue: action => action(),
    service: { getCharacteristic: async uuid => uuid.includes('354-') ? {
      writeValueWithResponse: async bytes => {
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        last = { op: bytes[1], id: v.getUint32(2, true), offset: v.getUint32(6, true) };
        if (last.op === 1) captures++;
      },
    } : { readValue: async () => {
      reads++;
      return initial.shift() || response(last.id, source.length, last.offset,
        last.op === 2 ? source.slice(last.offset, last.offset + 3) : []);
    } } },
  });
  const photo = await client.snapshot();
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), source);
  assert.equal(captures, 1, 'polling must not trigger duplicate exposures');
  assert.equal(reads, 6);
  assert.throws(() => decode(new DataView(new ArrayBuffer(15)), 1), /Invalid/);
  const malformed = new DataView(new ArrayBuffer(16));
  malformed.setUint8(1, 99);
  assert.throws(() => decode(malformed, 1), /Invalid/);
});
test('transfer ignores old replies, validates offsets and rejects changed file sizes', async () => {
  assert.equal(decode(response(1, 4, 0), 2), null);
  assert.equal(decode(response(2, 4, 0, [], 0), 2), null);
  let native = 0,
    max = 0,
    last;
  const file = Uint8Array.from([255, 216, 255, 217]);
  const client = new Client({
    service: {
      getCharacteristic: async (id) =>
        id.includes('354-')
          ? {
              writeValueWithResponse: async (b) => {
                const v = new DataView(b.buffer);
                last = { op: b[1], id: v.getUint32(2, true), offset: v.getUint32(6, true) };
              },
            }
          : {
              readValue: async () =>
                response(
                  last.id,
                  4,
                  last.offset,
                  last.op === 2 ? [...file.slice(last.offset, last.offset + 2)] : [],
                ),
            },
    },
    mediaQueue: async (fn) => {
      native++;
      max = Math.max(max, native);
      try {
        return await fn();
      } finally {
        native--;
      }
    },
  });
  assert.deepEqual(new Uint8Array(await (await client.snapshot()).arrayBuffer()), file);
  assert.equal(max, 1);
  let calls = 0;
  client.request = async () =>
    ++calls === 1 ? { total: 4 } : { total: 5, offset: 0, bytes: new Uint8Array(2) };
  await assert.rejects(client.snapshot(), /changed/);
});
