'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const protocol = require('../devices/chakshu/model-transfer.js');
test('model download checks exact size and SHA-256 before any device write', async () => {
  await assert.rejects(protocol.verify(new Uint8Array(10)), /incomplete/);
  await assert.rejects(protocol.verify(new Uint8Array(protocol.SIZE)), /integrity/);
  assert.throws(() => protocol.decode(new DataView(new ArrayBuffer(20))), /Update/);
});
function fixture(embedded = false) {
  let state = 0,
    offset = 0,
    id = 0,
    begins = 0,
    writes = 0,
    failAt = 1920,
    current = true;
  const realm = {
    Uint8Array,
    Uint32Array,
    DataView,
    TextEncoder,
    Error,
    Promise,
    Date,
    setTimeout,
    crypto: {
      getRandomValues: (a) => {
        a[0] = 42;
        return a;
      },
      // Protocol fixture data is all zero. Production hash checking is tested above.
      subtle: {
        digest: async (_, bytes) =>
          Uint8Array.from(
            Buffer.from(bytes.every((b) => b === 0) ? protocol.SHA256 : '00'.repeat(32), 'hex'),
          ).buffer,
      },
    },
  };
  vm.runInNewContext(fs.readFileSync('devices/chakshu/model-transfer.js', 'utf8'), realm);
  function status() {
    const v = new DataView(new ArrayBuffer(20));
    [0xce, 1, embedded ? 3 : state, 0].forEach((n, i) => v.setUint8(i, n));
    v.setUint32(4, id, true);
    v.setUint32(8, embedded ? protocol.SIZE : offset, true);
    v.setUint32(12, protocol.SIZE, true);
    v.setUint16(16, 480, true);
    v.setUint8(18, embedded ? 0 : 1);
    v.setUint8(19, embedded ? 2 : 1);
    return v;
  }
  const transport = {
    readValue: async () => status(),
    writeValueWithResponse: async (bytes) => {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        op = bytes[0];
      if (op === 1) {
        begins++;
        id = v.getUint32(1, true);
        offset = 0;
        state = 1;
      }
      if (op === 2) {
        if (offset >= failAt) {
          failAt = Infinity;
          throw Error('Lost link');
        }
        assert.equal(v.getUint32(5, true), offset);
        offset += bytes.length - 9;
        writes++;
      }
      if (op === 3) {
        assert.equal(offset, protocol.SIZE);
        state = 3;
      }
      if (op === 5) state = 4;
      if (op === 4) state = 5;
    },
  };
  const client = new realm.SynapChakshuModelTransfer.Client(
    {
      mediaQueue: async (action) => action(),
      service: { getCharacteristic: async () => transport },
    },
    () => {
      if (!current) throw Error('Account changed');
    },
  );
  return {
    client,
    get offset() {
      return offset;
    },
    get begins() {
      return begins;
    },
    get writes() {
      return writes;
    },
    changeAccount() {
      current = false;
    },
  };
}
test('PWA resumes without another BEGIN, finishes all bytes, and waits for restart acknowledgement', async () => {
  const f = fixture();
  await f.client.connect();
  const bytes = new Uint8Array(protocol.SIZE);
  await assert.rejects(f.client.install(bytes), /Lost link/);
  assert.equal(f.offset, 1920);
  assert.equal(f.begins, 1);
  const result = await f.client.install(bytes);
  assert.equal(result.state, 3);
  assert.equal(f.offset, protocol.SIZE);
  assert.equal(f.begins, 1);
  assert.equal((await f.client.restart()).state, 5);
});
test('cancel releases a paused session, and account changes stop further writes', async () => {
  const f = fixture();
  await f.client.connect();
  await assert.rejects(f.client.install(new Uint8Array(protocol.SIZE)), /Lost link/);
  assert.equal((await f.client.cancel()).state, 4);
  const writes = f.writes;
  f.changeAccount();
  await assert.rejects(f.client.install(new Uint8Array(protocol.SIZE)), /Account changed/);
  assert.equal(f.writes, writes);
});
test('firmware-installed model is available without SD and never starts a separate upload or restart', async () => {
  const f = fixture(true),
    status = await f.client.connect();
  assert.equal(status.embedded, true);
  assert.equal(status.sd, false);
  assert.equal(status.supported, false);
  assert.equal(status.state, 3);
  assert.equal((await f.client.install()).embedded, true);
  await f.client.cancel();
  await assert.rejects(f.client.restart(), /already included/);
  assert.equal(f.begins, 0);
  assert.equal(f.writes, 0);
});
