'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  crypto = require('node:crypto');
const source = fs.readFileSync('ota.js', 'utf8'),
  ID = 'SYNAP-AABBCCDDEEFF';
function fixture({
  build = 1224,
  target = 'xiao-esp32s3-sense-8m',
  deferred = true,
  resume = false,
  notify = true,
  deviceId = ID,
} = {}) {
  const realm = {
    navigator: { bluetooth: {} },
    Uint8Array,
    Uint32Array,
    DataView,
    TextEncoder,
    TextDecoder,
    crypto: crypto.webcrypto,
    setTimeout,
    Date,
  };
  vm.runInNewContext(source, realm);
  const api = realm.SynapOTA,
    bytes = new Uint8Array(8192),
    config = api.IMAGE_TARGETS[target];
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + Math.floor(i / 503)) & 255;
  bytes[0] = 0xe9;
  new DataView(bytes.buffer).setUint16(12, config.chip, true);
  new DataView(bytes.buffer).setUint32(32, 0xabcd5432, true);
  bytes.set(new TextEncoder().encode(config.marker), 64);
  const hash = crypto.createHash('sha256').update(bytes).digest();
  const state = {
    state: resume ? 3 : 1,
    session: resume ? 47 : 0,
    offset: resume ? 503 : 0,
    error: 0,
  };
  const received = resume ? [bytes.slice(0, 503)] : [],
    commands = [];
  let handler,
    value,
    pending = 0,
    peak = 0,
    last = null;
  function status() {
    const v = new DataView(new ArrayBuffer(20));
    [0xd7, 3, state.state, state.error].forEach((x, i) => v.setUint8(i, x));
    v.setUint32(4, state.session, true);
    v.setUint32(8, state.offset, true);
    v.setUint32(12, 0x330000, true);
    v.setUint16(16, 503, true);
    v.setUint16(18, build, true);
    return v;
  }
  const statusChar = {
    addEventListener: (_, f) => (handler = f),
    removeEventListener: () => (handler = null),
    startNotifications: async () => {},
    readValue: async () => status(),
  };
  function execute(data) {
    const v = new DataView(data.buffer, data.byteOffset, data.length),
      op = data[0];
    commands.push(op);
    if (op === 1) {
      assert.equal(v.getUint32(5, true), bytes.length);
      assert.deepEqual(Buffer.from(data.slice(9, 41)), hash);
      state.session = v.getUint32(1, true);
      state.offset = 0;
      state.error = 0;
      state.state = 3;
      received.length = 0;
    }
    if (op === 6) {
      assert.equal(v.getUint32(1, true), state.session);
      assert.deepEqual(Buffer.from(data.slice(9, 41)), hash);
    }
    if (op === 2 && state.state === 3) {
      const offset = v.getUint32(5, true);
      if (
        last &&
        offset === last.offset &&
        Buffer.from(last.data).equals(Buffer.from(data.slice(9)))
      ) {
        /* firmware permits the last exact retry */
      } else if (offset !== state.offset) {
        state.state = 6;
        state.error = 4;
      } else {
        last = { offset, data: data.slice(9) };
        received.push(last.data);
        state.offset += last.data.length;
      }
    }
    if (op === 3) {
      assert.equal(state.offset, bytes.length);
      assert.deepEqual(Buffer.concat(received), Buffer.from(bytes));
      state.state = 4;
    }
    if (op === 4) {
      assert.equal(state.state, 4);
      state.state = 5;
    }
    if (op === 5) {
      state.state = 6;
      state.error = 10;
    }
    if (notify) handler?.({ target: { value: status() } });
  }
  const write = {
    writeValueWithResponse: async (data) => {
      value = data.slice();
      const owned = deferred ? null : value;
      ++pending;
      peak = Math.max(peak, pending);
      // Arduino's older callback holds a characteristic pointer, not this write's
      // bytes. The ATT response resolves before that callback runs.
      setTimeout(() => {
        --pending;
        execute(owned || value);
      }, 15);
    },
  };
  const client = new api.Client({
    connected: () => true,
    queue: async (f) => f(),
    progress() {},
    getService: async () => ({
      getCharacteristic: async (uuid) =>
        uuid.includes('12348')
          ? write
          : uuid.includes('1234c')
            ? { readValue: async () => new TextEncoder().encode(deviceId) }
            : statusChar,
    }),
  });
  return {
    api,
    client,
    file: { size: bytes.length, arrayBuffer: async () => bytes.buffer },
    commands,
    state,
    get peak() {
      return peak;
    },
  };
}
test('old Chakshu OTA copies and acknowledges each packet before the next browser write', async () => {
  const f = fixture();
  assert.equal(f.api.WINDOW_CHUNKS, 4, 'exercise the browser, not the Node single-chunk default');
  await f.client.check();
  assert((await f.client.update(f.file, ID)).committed);
  assert.equal(f.peak, 1);
  assert.equal(f.state.error, 0);
});
test('old Chakshu resumes its persisted offset without restarting flash', async () => {
  const f = fixture({ resume: true });
  await f.client.check();
  assert((await f.client.update(f.file, ID)).committed);
  assert.equal(f.commands[0], 6);
  assert(!f.commands.includes(1));
  assert.equal(f.peak, 1);
});
test('new Chakshu and the other targets retain the existing cumulative ACK window', async () => {
  for (const options of [
    { build: 1227 },
    { build: 1200, target: 'esp32s3-fh4r2-qspi-4m' },
    { build: 1200, target: 'esp32c3-supermini-4m' },
  ]) {
    const f = fixture({ ...options, deferred: false });
    await f.client.check();
    assert((await f.client.update(f.file, ID)).committed);
    assert.equal(f.peak, 4);
  }
});
test('old Chakshu can use read acknowledgements when notifications are unavailable', async () => {
  const f = fixture({ notify: false });
  await f.client.check();
  assert((await f.client.update(f.file, ID)).committed);
  assert.equal(f.peak, 1);
  assert.equal(f.state.error, 0);
});

test('installed Chakshu 1227 with a NUL-terminated ID can check, target and finish an OTA update',async()=>{
  const f=fixture({build:1227,deferred:false,deviceId:ID+'\0'});
  assert.equal((await f.client.check()).deviceId,ID);
  assert((await f.client.update(f.file,ID)).committed);
  assert.equal(f.state.error,0);
});
test('OTA still rejects malformed IDs and preserves target mismatch checks for C-string IDs',async()=>{
  for(const deviceId of [ID+'X',ID+'\0\0',ID+'\0X','SYNAP-000000000000\0','SYNAP-FFFFFFFFFFFF\0',ID.toLowerCase()+'\0']){
    const f=fixture({build:1227,deviceId});
    await assert.rejects(f.client.check(),/Invalid pendant device ID/);assert.equal(f.commands.length,0);
  }
  const f=fixture({build:1227,deviceId:'SYNAP-112233445566\0'});
  await f.client.check();
  await assert.rejects(f.client.update(f.file,ID),/Device ID mismatch/);
  assert.equal(f.commands.length,0);
});
