'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  windowFrames,
  explainWords,
  splitMJPEG,
  filterMedia,
} = require('../devices/chakshu/store.js');
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
const { decode, Client } = require('../devices/chakshu/transfer.js');
test('SD errors preserve optional firmware diagnostics and legacy error handling', () => {
  const storage = { sdReady: false, sdClockHz: 1000000, sdMountStage: 'directory', sdMountAttempts: 3, freeHeap: 24000 };
  const packet = response(7, 0, 0, new TextEncoder().encode(JSON.stringify(storage)), 2);
  packet.setUint8(3, 3);
  assert.throws(() => decode(packet, 7), (error) => {
    assert.match(error.message, /SD card unavailable/);
    assert.deepEqual(error.storage, storage);
    return true;
  });
  assert.equal(decode(packet, 8), null); // stale errors cannot belong to a new request
  for (const payload of [[], [123], new TextEncoder().encode('null')]) {
    const legacy = response(7, 0, 0, payload, 2);
    legacy.setUint8(3, 7);
    assert.throws(() => decode(legacy, 7), (error) => {
      assert.match(error.message, /SD write\/read failed/);
      assert.equal(error.storage, undefined);
      return true;
    });
  }
  const missing = response(9, 0, 0, [], 2);
  missing.setUint8(3, 11);
  assert.throws(() => decode(missing, 9), (error) => {
    assert.match(error.message, /SD file unavailable/);
    assert.equal(error.storage, undefined, 'a stale file is not a whole-card fault');
    return true;
  });
});
test('camera failure diagnostics identify discovery, command and response stages', async () => {
  const vm = require('node:vm'),
    fs = require('node:fs'),
    path = require('node:path');
  for (const failed of [
    'Find Chakshu camera controls',
    'Find Chakshu camera data',
    'Send Chakshu camera request',
    'Read Chakshu camera response',
  ]) {
    const reports = [],
      c = {
        Promise,
        Uint8Array,
        DataView,
        TextEncoder,
        Date,
        CustomEvent: class {
          constructor(type, { detail }) {
            this.type = type;
            this.detail = detail;
          }
        },
        dispatchEvent: (event) => reports.push(event),
      };
    vm.createContext(c);
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '../devices/chakshu/transfer.js'), 'utf8'),
      c,
    );
    const client = new c.SynapChakshuTransfer.Client({
      // Native Bluetooth bridges can reject with a string, not an Error object.
      queue: async (action, label) => {
        if (label === failed) throw 'GATT Error Unknown.';
        return action();
      },
      service: {
        getCharacteristic: async () => ({
          writeValueWithResponse: async () => {},
          readValue: async () => response(1, 0, 0),
        }),
      },
    });
    await assert.rejects(client.request(1), /GATT Error Unknown/);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].detail.stage, failed);
    assert.equal(reports[0].detail.operation, 1);
    assert.equal(reports[0].detail.offset, 0);
    assert.equal(reports[0].detail.message, 'GATT Error Unknown.');
    assert.equal(typeof reports[0].detail.elapsedMs, 'number');
  }
});
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
  let last,
    reads = 0,
    captures = 0;
  const initial = [
    new DataView(new ArrayBuffer(0)),
    new DataView(new ArrayBuffer(16)),
    response(0, 0, 0),
  ];
  const client = new Client({
    queue: (action) => action(),
    service: {
      getCharacteristic: async (uuid) =>
        uuid.includes('354-')
          ? {
              writeValueWithResponse: async (bytes) => {
                const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                last = { op: bytes[1], id: v.getUint32(2, true), offset: v.getUint32(6, true) };
                if (last.op === 1) captures++;
              },
            }
          : {
              readValue: async () => {
                reads++;
                return (
                  initial.shift() ||
                  response(
                    last.id,
                    source.length,
                    last.offset,
                    last.op === 2 ? source.slice(last.offset, last.offset + 3) : [],
                  )
                );
              },
            },
    },
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
test('camera commands prefer write without response when the pendant advertises it', async () => {
  let responseWrites = 0,
    commandWrites = 0,
    id = 0;
  const client = new Client({
    queue: (action) => action(),
    service: {
      getCharacteristic: async (uuid) =>
        uuid.includes('354-')
          ? {
              properties: { write: true, writeWithoutResponse: true },
              writeValueWithResponse: async () => {
                responseWrites++;
                throw Object.assign(new Error('GATT Error Unknown.'), {
                  name: 'NotSupportedError',
                });
              },
              writeValueWithoutResponse: async (bytes) => {
                commandWrites++;
                id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
                  2,
                  true,
                );
              },
            }
          : { readValue: async () => response(id, 0, 0) },
    },
  });
  await client.request(9);
  assert.equal(commandWrites, 1);
  assert.equal(responseWrites, 0);
});
test('SD file paths retain long writes while chunk requests use short commands', async () => {
  const writes = [];
  let last;
  const accept = (bytes, method) => {
    writes.push({ method, length: bytes.length });
    last = { id: new DataView(bytes.buffer).getUint32(2, true), op: bytes[1] };
  };
  const client = new Client({
    queue: (action) => action(),
    service: {
      getCharacteristic: async (uuid) =>
        uuid.includes('354-')
          ? {
              properties: { write: true, writeWithoutResponse: true },
              writeValueWithResponse: async (bytes) => accept(bytes, 'long'),
              writeValueWithoutResponse: async (bytes) => {
                assert(bytes.length <= 20, 'a short command must fit the minimum ATT payload');
                accept(bytes, 'short');
              },
            }
          : { readValue: async () => response(last.id, 3, 0, last.op === 4 ? [7, 8, 9] : []) },
    },
  });
  const blob = await client.file('/synap/abcdef01-00000001.jpg');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), Uint8Array.of(7, 8, 9));
  assert.deepEqual(
    writes.map((x) => x.method),
    ['long', 'short'],
  );
  assert(writes[0].length > 20);
});
test('an ambiguous camera write failure cannot repeat a capture', async () => {
  let writes = 0;
  const client = new Client({
    queue: (action) => action(),
    service: {
      getCharacteristic: async (uuid) =>
        uuid.includes('354-')
          ? {
              properties: { write: true },
              writeValueWithResponse: async () => {
                writes++;
                throw new DOMException('GATT Error Unknown.', 'NetworkError');
              },
              writeValueWithoutResponse: async () => {
                writes++;
              },
            }
          : { readValue: async () => assert.fail('failed writes must not consume stale results') },
    },
  });
  await assert.rejects(client.snapshot(), /GATT Error Unknown/);
  assert.equal(writes, 1);
});
test('a lost short command times out without reissuing a photo', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let writes = 0;
  const client = new Client({
    queue: (action) => action(),
    service: {
      getCharacteristic: async (uuid) =>
        uuid.includes('354-')
          ? {
              properties: { writeWithoutResponse: true },
              writeValueWithoutResponse: async () => {
                writes++;
              },
            }
          : { readValue: async () => response(0, 0, 0) },
    },
  });
  const request = assert.rejects(client.snapshot(), /Camera request timed out/);
  await new Promise(setImmediate);
  t.mock.timers.tick(12001);
  await request;
  assert.equal(writes, 1);
});
test('transfer ignores old replies, validates offsets and rejects changed file sizes', async () => {
  assert.equal(decode(response(1, 4, 0), 2), null);
  assert.equal(decode(response(2, 4, 0, [], 0), 2), null);
  let native = 0,
    max = 0,
    last,
    changed = false;
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
                  changed && last.op === 2 ? 5 : 4,
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
  changed = true;
  await assert.rejects(client.snapshot(), /changed/);
});
test('background status, photos and SD catalogue serialize complete transfers without replacing their source', async () => {
  const photo = Uint8Array.from([255, 216, 1, 2, 255, 217]);
  const files = [{ path: '/synap/abcdef01-00000001.jpg', bytes: 6 }];
  let source = new Uint8Array(),
    last,
    active = 0,
    maximum = 0;
  const ops = [];
  const client = new Client({
    mediaQueue: async (action) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await action();
      } finally {
        active--;
      }
    },
    service: {
      getCharacteristic: async (uuid) =>
        uuid.includes('354-')
          ? {
              writeValueWithResponse: async (bytes) => {
                await new Promise(setImmediate);
                const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                last = { op: bytes[1], id: v.getUint32(2, true), offset: v.getUint32(6, true) };
                ops.push(last.op);
                if (last.op === 1) source = photo;
                if (last.op === 7) source = new TextEncoder().encode(JSON.stringify(files));
              },
            }
          : {
              readValue: async () =>
                response(
                  last.id,
                  source.length,
                  last.offset,
                  last.op === 9
                    ? new TextEncoder().encode('{"active":false}')
                    : [2, 4].includes(last.op)
                      ? source.slice(last.offset, last.offset + 3)
                      : [],
                ),
            },
    },
  });
  const [status, first, catalogue, second] = await Promise.all([
    client.request(9),
    client.snapshot(),
    client.catalogue(),
    client.snapshot(),
  ]);
  assert.equal(JSON.parse(new TextDecoder().decode(status.bytes)).active, false);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), photo);
  assert.deepEqual(catalogue, files);
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), photo);
  assert.deepEqual(ops.slice(0, 6), [9, 1, 2, 2, 7, 8]);
  assert.equal(maximum, 1);
});
test('cancelled camera work waiting behind a request never reaches the pendant and does not block the next request', async () => {
  let release, last;
  const writes = [];
  const client = new Client({
    queue: (action) => action(),
    service: {
      getCharacteristic: async (uuid) =>
        uuid.includes('354-')
          ? {
              writeValueWithResponse: async (bytes) => {
                last = new DataView(bytes.buffer).getUint32(2, true);
                writes.push(bytes[1]);
                if (writes.length === 1) await new Promise((resolve) => (release = resolve));
              },
            }
          : { readValue: async () => response(last, 0, 0) },
    },
  });
  const first = client.request(9);
  while (!release) await new Promise(setImmediate);
  const controller = new AbortController(),
    photo = client.snapshot(controller.signal);
  const cancelled = assert.rejects(photo, { name: 'AbortError' });
  controller.abort();
  release();
  await first;
  await cancelled;
  await client.request(9);
  assert.deepEqual(writes, [9, 9]);
});

test('video requests smaller frames while photo bytes, progress and cancellation stay exact', async () => {
  const source = new Uint8Array([255, 216, 1, 2, 3, 4, 5, 255, 217]),
    requests = [];
  let last;
  const client = new Client({
    queue: (action) => action(),
    service: {
      getCharacteristic: async (uuid) =>
        uuid.includes('354-')
          ? {
              properties: { writeWithoutResponse: true },
              writeValueWithoutResponse: async (bytes) => {
                const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                last = { op: bytes[1], id: v.getUint32(2, true), offset: v.getUint32(6, true) };
                requests.push(last);
              },
            }
          : {
              readValue: async () =>
                response(
                  last.id,
                  source.length,
                  last.op === 1 ? 0 : last.offset,
                  last.op === 2 ? source.slice(last.offset, last.offset + 3) : [],
                ),
            },
    },
  });
  for (const preview of [false, true]) {
    requests.length = 0;
    const progress = [];
    const blob = await client.snapshot(
      undefined,
      (fraction, total) => progress.push([fraction, total]),
      preview,
    );
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), source);
    assert.equal(requests[0].offset, preview ? 1 : 0);
    assert.deepEqual(
      requests.slice(1).map((r) => r.offset),
      [0, 3, 6],
    );
    assert.deepEqual(progress, [
      [0, 9],
      [1 / 3, 9],
      [2 / 3, 9],
      [1, 9],
    ]);
  }
  requests.length = 0;
  const controller = new AbortController();
  await assert.rejects(
    client.snapshot(
      controller.signal,
      (fraction) => {
        if (fraction > 0) controller.abort();
      },
      true,
    ),
    { name: 'AbortError' },
  );
  assert.equal(requests.filter((r) => r.op === 1).length, 1);
  assert.equal(
    requests.filter((r) => r.op === 2).length,
    1,
    'cancel must not save or finish a partial JPEG',
  );
  assert.deepEqual(
    new Uint8Array(await (await client.snapshot()).arrayBuffer()),
    source,
    'a cancelled video must not poison the next standalone photo',
  );
});

test('device voice media sync discovers SD media and only explicit verified sync deletes originals',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const media=fs.readFileSync(path.join(__dirname,'../devices/chakshu/media.js'),'utf8');
  const lifecycle=fs.readFileSync(path.join(__dirname,'../devices/chakshu/capture-preview.js'),'utf8');
  const voice=fs.readFileSync(path.join(__dirname,'../devices/chakshu/voice.js'),'utf8');
  const sync=media.slice(media.indexOf('async function syncPendingSD()'),media.indexOf('const apiObject'));
  const move=media.slice(media.indexOf('async function moveSD('),media.indexOf('async function syncPendingSD()'));
  assert.match(sync,/const files = await catalogueNow\(\)/);
  assert.doesNotMatch(sync,/operation\(/,'background SD discovery must not claim foreground capture state');
  assert.doesNotMatch(sync,/importSD\(|deleteSyncedSet\(/);
  assert.match(move,/SynapChakshuV2\?\.moveSD/);
  assert.match(move,/return verified\(path, progress\)/);
  assert.match(lifecycle,/async function verifyVisual/);
  assert.match(lifecycle,/async function verifyAudio/);
  assert.match(lifecycle,/SD original was kept/);
  const deletion=lifecycle.slice(lifecycle.indexOf('async function deleteSyncedSet'),lifecycle.indexOf('async function moveSD'));
  assert(deletion.indexOf("stem(path) + '.json'") < deletion.indexOf('return deleteSD(path)'));
  assert(deletion.indexOf("stem(path) + '.wav'") < deletion.indexOf('return deleteSD(path)'));
  const verifiedMove=lifecycle.slice(lifecycle.indexOf('async function moveSD'),lifecycle.indexOf('async function clearSD'));
  assert.match(verifiedMove,/localStorage\.setItem\(key, JSON\.stringify\(receipt\)\)[\s\S]*await deleteSyncedSet\(path\)/);
  assert.match(voice,/Firmware owns capture/);
  assert.match(media,/if \(next && !wifi\?\.active\) schedulePendingSync\(1200\)/);
  // An unmounted card answers "SD card unavailable" after ~4.6s on the shared
  // media queue, and module-changed re-arms the sweep every ~15s. One probe per
  // connection still lets a catalogue trigger firmware re-detection; a loop
  // would spend a third of the queue re-asking an answered question.
  assert.match(sync,/if \(!sdWorthCataloguing\(deviceId\)\) return 0;/);
  const probe=media.slice(media.indexOf('function sdWorthCataloguing'),media.indexOf('function schedulePendingSync'));
  assert.match(probe,/capabilities\.ready\(moduleInfo\(\), 'sd'\)/);
  assert.match(probe,/sdProbe\.attempted && sdProbe\.deviceId === deviceId\) return false/);
  // The probe must be forgotten wherever the card could have changed, or a
  // reseated card would stay invisible for the rest of the session.
  assert.match(media,/forgetSDProbe\(\);\s*\n\s*try \{/,'Check SD card clears the probe');
  const dropped=media.slice(media.indexOf("addEventListener('synap-gatt-disconnected'"));
  assert.match(dropped.slice(0,400),/forgetSDProbe\(\)/,'disconnect clears the probe');
  assert.doesNotMatch(voice,/synap-chakshu-media-pending/);
  assert.doesNotMatch(voice,/startOffline\(0, 10\)|describeNow\(\)|highQualitySnap/);
});

test('unsynced Chakshu audio photo and video surface in the shared Library before transfer',()=> {
  const fs=require('node:fs'),path=require('node:path');
  const media=fs.readFileSync(path.join(__dirname,'../devices/chakshu/media.js'),'utf8');
  const library=fs.readFileSync(path.join(__dirname,'../devices/chakshu/library.js'),'utf8');
  const lifecycle=fs.readFileSync(path.join(__dirname,'../devices/chakshu/capture-preview.js'),'utf8');
  const voice=fs.readFileSync(path.join(__dirname,'../devices/chakshu/voice.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.match(media,/function rememberCatalogue\(files, deviceId\)/);
  assert.match(media,/sdFiles: sdFiles\.slice\(\)/);
  assert.match(media,/videoStems = new Set/);
  assert.match(media,/describe: Boolean\(file\?\.describe\)/);
  assert.match(lifecycle,/async function describeVisual\(visualId, blob/);
  assert.match(lifecycle,/wantsDescribe = Boolean\(api\(\)\.state\.sdFiles/);
  assert.match(lifecycle,/receipt\.description = await describeVisual\(visualId, source\.main\)/);
  assert.match(lifecycle,/Description ready; verified SD source removed/);
  assert.match(library,/describeRequested: Boolean\(file\.describe\)/);
  assert.match(library,/Sync & describe/);
  assert.match(media,/!\/\\\.wav\$\/i\.test\(file\.path\) \|\| !videoStems\.has/);
  assert.match(library,/\(jpg\|mjpeg\|wav\)/);
  assert.match(library,/sdOnly: true/);
  assert.match(library,/Not synced · On Chakshu SD/);
  assert.match(library,/Sync to app/);
  assert.match(library,/SynapChakshuV2\?\.moveSD/);
  assert.match(lifecycle,/The imported visual could not be verified\. The SD original was kept\./);
  assert.match(lifecycle,/The imported audio could not be verified\. The SD original was kept\./);
  assert.match(voice,/await write\(b, VOICE_OFF\)/);
  assert.doesNotMatch(voice,/startNotifications|characteristicvaluechanged/);
  const headerStart=html.indexOf('class="topbar"'),headerEnd=html.indexOf('</header>',headerStart),feedback=html.indexOf('id="heySynapFeedback"');
  assert(headerStart>=0&&feedback>headerStart&&feedback<headerEnd,'voice feedback must render inside the header, below device controls');
});

test('connected Chakshu uses PWA capture while SD is an unsynced offline inbox', () => {
  const fs = require('node:fs'), path = require('node:path');
  const media = fs.readFileSync(path.join(__dirname, '../devices/chakshu/media.js'), 'utf8');
  const library = fs.readFileSync(path.join(__dirname, '../devices/chakshu/library.js'), 'utf8');
  const lifecycle = fs.readFileSync(path.join(__dirname, '../devices/chakshu/capture-preview.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(media, /async function startOffline\(\)[\s\S]*available only while Chakshu is disconnected/);
  assert.match(media, /offlineReady: false/);
  assert.match(media, /synap-chakshu-sd-pending/);
  assert.match(library, /\(jpg\|mjpeg\|wav\)/);
  assert.match(library, /Not synced · On Chakshu SD/);
  assert.match(library, /SynapChakshuV2\?\.moveSD/);
  assert.match(lifecycle, /async function syncAll\(\)/);
  assert.match(lifecycle, /verification failed/);
  assert.match(lifecycle, /Verified SD source removed/);
  assert.match(html, /While Chakshu is disconnected from this app, Hey Snap owns capture/);
  assert.match(html, /id="visualSDSyncNotice"/);
  assert.match(html, /id="librarySDInbox"/);
  assert.match(html, /id="libraryCheckSD"/);
  assert.match(html, /id="libraryBrowseSD"/);
  assert.match(html, /id="librarySyncSD"/);
  assert.match(lifecycle, /Sync copies each item to Memories, verifies it, then removes the SD original/);
  assert.match(lifecycle, /Connect Chakshu to check or sync its SD card/);
  assert.match(lifecycle, /SD card unavailable\. Choose Check SD/);
  assert.match(lifecycle, /libraryCheck\?\.addEventListener\('click'/);
  assert.match(lifecycle, /browseSD\('librarySDList'\)/);
  assert.match(lifecycle, /SynapChakshuVoice\?\.lastOutcome\?\.\(deviceId\)/);
  assert.match(lifecycle, /Last offline result:/);
  assert.match(html, /id="visualRecordSD"[^>]*disabled/);
});
