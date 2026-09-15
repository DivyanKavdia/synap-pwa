'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { Client, MediaWindow } = require('../devices/chakshu/transfer.js');
function packet(id, total, offset, bytes = [], kind = 1, magic = 0xcc) {
  const view = new DataView(new ArrayBuffer(16 + bytes.length));
  [magic, 1, kind, 0].forEach((n, i) => view.setUint8(i, n));
  view.setUint32(4, id, true);
  view.setUint32(8, total, true);
  view.setUint32(12, offset, true);
  new Uint8Array(view.buffer).set(bytes, 16);
  return view;
}
test('camera windows recover only contiguous bytes and reject conflicts, overlaps and excess credit', () => {
  const w = new MediaWindow(7, 0, 12);
  assert(!w.accept(packet(6, 12, 0, [9])));
  w.accept(packet(7, 12, 4, [4, 5, 6, 7]));
  w.accept(packet(7, 12, 0, [0, 1, 2, 3]));
  w.accept(packet(7, 12, 4, [4, 5, 6, 7])); // exact duplicate is harmless
  assert.equal(w.contiguous().next, 8);
  assert.throws(() => w.accept(packet(7, 12, 4, [9, 5, 6, 7])), /Conflicting/);
  assert.throws(() => w.accept(packet(7, 12, 6, [6, 7, 8, 9])), /Overlapping/);
  assert.throws(() => w.accept(packet(7, 11, 8, [8])), /changed/);
  w.accept(packet(7, 12, 12, [], 2));
  assert(w.ended);
  assert.equal(w.contiguous().next, 8);
  const full = new MediaWindow(9, 0, 20);
  for (let i = 0; i < 8; i++) full.accept(packet(9, 20, i, [i]));
  assert.throws(() => full.accept(packet(9, 20, 8, [8])), /credit/);
  const yielding = new MediaWindow(10, 480, 2000);
  yielding.accept(packet(10, 0, 480, [], 2));
  assert(yielding.ended);
  assert.equal(yielding.contiguous().next, 480);
});
function fixture({
  features = 1,
  drop = false,
  yielding = false,
  abort,
  failSubscribe = false,
} = {}) {
  const bytes = Uint8Array.from({ length: 10561 }, (_, i) => (i * 73) % 256),
    writes = [],
    stream = new EventTarget();
  let last,
    windows = 0,
    subscribes = 0,
    maximum = 0,
    inFlight = 0,
    tail = Promise.resolve();
  stream.startNotifications = async () => {
    if (++subscribes === 1 && failSubscribe) throw Error('Subscribe failed');
  };
  const emit = (value) => {
    stream.value = value;
    stream.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  const write = async (data) => {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    last = { op: data[1], id: v.getUint32(2, true), offset: v.getUint32(6, true) };
    writes.push({ ...last });
    if (last.op !== 12) return;
    ++windows;
    const { id, offset } = last;
    if (abort) {
      abort.abort();
      await new Promise((r) => setTimeout(r, 5));
      return;
    }
    if (yielding) {
      emit(packet(id, 0, offset, [], 2));
      return;
    }
    const chunks = [];
    let end = offset;
    for (let i = 0; i < 8 && end < bytes.length; i++) {
      const start = end;
      end = Math.min(end + 480, bytes.length);
      if (!(drop && windows === 1 && i === 1))
        chunks.push(packet(id, bytes.length, start, bytes.slice(start, end)));
    }
    // The bridge can deliver during its unresolved native write promise.
    chunks.reverse().forEach(emit);
    emit(packet(id, bytes.length, end, [], 2));
    await new Promise((r) => setTimeout(r, 1));
  };
  const command = {
    properties: { writeWithoutResponse: true },
    writeValueWithoutResponse: write,
    writeValueWithResponse: write,
  };
  const data = {
    readValue: async () =>
      packet(
        last.id,
        bytes.length,
        last.offset,
        last.op === 2 ? bytes.slice(last.offset, last.offset + 480) : [],
        1,
        0xcb,
      ),
  };
  const context = {
    mediaFeatures: features,
    queue(action) {
      const next = tail.then(async () => {
        maximum = Math.max(maximum, ++inFlight);
        try {
          return await action();
        } finally {
          --inFlight;
        }
      });
      tail = next.catch(() => {});
      return next;
    },
    service: {
      getCharacteristic: async (uuid) =>
        uuid.includes('35a-') ? stream : uuid.includes('354-') ? command : data,
    },
  };
  return {
    client: new Client(context),
    bytes,
    writes,
    get maximum() {
      return maximum;
    },
    get subscribes() {
      return subscribes;
    },
  };
}
test('paced notifications recover a dropped packet without recapturing or per-chunk reads', async () => {
  const f = fixture({ drop: true });
  const photo = await f.client.snapshot();
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), f.bytes);
  assert.equal(f.writes.filter((w) => w.op === 1).length, 1);
  assert.equal(f.writes.filter((w) => w.op === 2).length, 0);
  assert.equal(f.writes.filter((w) => w.op === 12)[1].offset, 480);
  assert.equal(f.maximum, 1);
  assert.equal(f.subscribes, 1);
});
test('silent notification delivery falls back to reading the same exposure; old firmware still reads directly', async () => {
  for (const opts of [{ yielding: true }, { features: 0 }]) {
    const f = fixture(opts);
    const photo = await f.client.snapshot();
    assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), f.bytes);
    assert.equal(f.writes.filter((w) => w.op === 1).length, 1);
    assert(f.writes.some((w) => w.op === 2));
    assert.equal(f.writes.filter((w) => w.op === 16).length, opts.yielding ? 1 : 0);
  }
});
test('cancelled notification capture keeps native ownership until the write settles and cancels remaining credit', async () => {
  const abort = new AbortController(),
    f = fixture({ abort });
  await assert.rejects(f.client.snapshot(abort.signal), { name: 'AbortError' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.maximum, 1);
  assert.equal(f.writes.filter((w) => w.op === 1).length, 1);
  assert(f.writes.some((w) => w.op === 16));
});
test('a failed subscription is retryable and is not cached as subscribed', async () => {
  const f = fixture({ failSubscribe: true });
  await assert.rejects(f.client.subscribeStream(), /Subscribe failed/);
  await f.client.subscribeStream();
  assert.equal(f.subscribes, 2);
});
test('a browser without the new notification characteristic reads the same captured image', async () => {
  const f = fixture({ failSubscribe: true });
  const photo = await f.client.snapshot();
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), f.bytes);
  assert.equal(f.writes.filter((w) => w.op === 1).length, 1);
  assert(f.writes.some((w) => w.op === 2));
  assert.equal(f.subscribes, 1);
});
