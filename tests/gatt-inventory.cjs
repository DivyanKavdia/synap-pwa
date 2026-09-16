'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discoverService } = require('../devices/identity.js');
const { Client, UUID } = require('../devices/modules.js');
const queue = (action) => action();
const audioId = '4fa12346-0000-1000-8000-00805f9b34fb';

test('complete service inventory avoids native probes for absent optional S3 extensions', async () => {
  let probes = 0,
    enumerations = 0;
  const audio = { uuid: audioId };
  const service = {
    async getCharacteristics() {
      enumerations++;
      return [audio];
    },
    getCharacteristic() {
      probes++;
      return new Promise(() => {});
    },
  };
  const cached = await discoverService(service, queue, () => {});
  for (let n = 0; n < 3; n++) {
    assert.equal(await cached.getCharacteristic(audioId.toUpperCase()), audio);
    await assert.rejects(cached.getCharacteristic(UUID), { name: 'NotFoundError' });
  }
  assert.equal(enumerations, 1);
  assert.equal(probes, 0, 'unsupported UUID discovery never enters the native bridge');
});

test('inventory belongs to one connection and is rebuilt after a firmware or device change', async () => {
  let epoch = 1,
    contents = [{ uuid: audioId }];
  const service = { getCharacteristics: async () => contents };
  const check = (expected) => () => {
    if (epoch !== expected) throw Error('connection changed');
  };
  const first = await discoverService(service, queue, check(1));
  epoch++;
  await assert.rejects(first.getCharacteristic(audioId), /connection changed/);
  contents = [{ uuid: audioId }, { uuid: UUID }];
  const next = await discoverService(service, queue, check(2));
  assert.equal(await next.getCharacteristic(UUID), contents[1]);
  await assert.rejects(discoverService(service, queue, check(1)), /connection changed/);
});

test('only an explicit unsupported inventory API uses individual discovery', async () => {
  const older = { getCharacteristic() {} };
  assert.equal(await discoverService(older, queue, () => {}), older);
  const unsupported = {
    getCharacteristics() {
      throw Object.assign(Error(), { name: 'NotSupportedError' });
    },
  };
  assert.equal(await discoverService(unsupported, queue, () => {}), unsupported);
  for (const reason of [2, Object.assign(Error('lost'), { name: 'NetworkError' })]) {
    await assert.rejects(
      discoverService({ getCharacteristics: () => Promise.reject(reason) }, queue, () => {}),
    );
  }
  for (const value of [null, [], [{}]]) {
    await assert.rejects(
      discoverService({ getCharacteristics: async () => value }, queue, () => {}),
      /incomplete/,
    );
  }
});

test('a legacy pendant with neither capability nor build identity finishes optional setup once', async () => {
  const calls = [];
  const client = new Client({
    queue,
    service: {
      getCharacteristic: async (uuid) => {
        calls.push(uuid);
        throw Object.assign(Error('absent'), { name: 'NotFoundError' });
      },
    },
  });
  for (let n = 0; n < 5; n++) assert.equal(await client.refresh(), true);
  assert.equal(client.available, true);
  assert.equal(client.module, null);
  assert.equal(client.error, '');
  assert.equal(calls.length, 2);
});

test('S3/C3 capability reads stop after identification while Chakshu keeps refreshing readiness', async () => {
  for (const id of [1, 2]) {
    let reads = 0;
    const client = new Client({
      queue,
      service: {
        getCharacteristic: async () => ({
          readValue: async () => {
            reads++;
            const value = new DataView(new ArrayBuffer(20));
            [0xc7, 1, id, 1].forEach((n, i) => value.setUint8(i, n));
            return value;
          },
        }),
      },
    });
    await client.refresh();
    await client.refresh();
    assert.equal(client.module.id, id);
    assert.equal(reads, 1);
  }
});
