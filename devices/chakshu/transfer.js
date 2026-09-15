/* Versioned request/response media transport on the app-owned Bluetooth queue. */
(function (root) {
  'use strict';
  const COMMAND = '4fa12354-0000-1000-8000-00805f9b34fb',
    DATA = '4fa12355-0000-1000-8000-00805f9b34fb';
  const delay = (ms) => new Promise((resolve) => root.setTimeout(resolve, ms));
  function decode(value, id) {
    // Released firmware starts with a zeroed 16-byte response. Its worker (and
    // Arduino's deferred write callback) may not have answered the first read.
    if (
      value.byteLength === 0 ||
      (value.byteLength === 16 &&
        new Uint8Array(value.buffer, value.byteOffset, 16).every((byte) => byte === 0))
    )
      return null;
    if (value.byteLength < 16 || value.getUint8(0) !== 0xcb || value.getUint8(1) !== 1)
      throw Error('Invalid camera transfer response.');
    if (value.getUint32(4, true) !== id || value.getUint8(2) === 0) return null;
    if (value.getUint8(2) !== 1)
      throw Error(
        [
          '',
          'Chakshu is busy.',
          'Unsupported media request.',
          'SD file unavailable.',
          'Camera unavailable.',
          'Microphone unavailable.',
          'SD card full.',
          'SD write/read failed.',
          'Capture failed.',
        ][value.getUint8(3)] || 'Camera transfer failed.',
      );
    return {
      total: value.getUint32(8, true),
      offset: value.getUint32(12, true),
      bytes: new Uint8Array(value.buffer, value.byteOffset + 16, value.byteLength - 16).slice(),
    };
  }
  class Client {
    constructor(context) {
      this.context = context;
      this.id = 0;
      this.operations = Promise.resolve();
      this.command = null;
      this.data = null;
    }
    serialize(action) {
      // The pendant has one response and one selected image/file. Keep that
      // source owned through all chunks; status polling waits its turn too.
      // Native ATT operations still use the shared queue below, so microphone
      // commands can run between camera chunks.
      const operation = this.operations.then(action);
      this.operations = operation.catch(() => {});
      return operation;
    }
    request(op, offset = 0, path = '', signal) {
      return this.serialize(() => this._request(op, offset, path, signal));
    }
    async writeCommand(run, bytes) {
      const characteristic = this.command,
        properties = characteristic.properties || {};
      // The matching response ID confirms execution. Short commands fit even
      // MTU23 and do not need a separate ATT write acknowledgement. File paths
      // can exceed that limit; retain long-write support for those requests.
      if (
        bytes.byteLength <= 20 &&
        properties.writeWithoutResponse &&
        typeof characteristic.writeValueWithoutResponse === 'function'
      )
        return run(
          () => characteristic.writeValueWithoutResponse(bytes),
          'Send Chakshu camera request',
        );
      // An ambiguous write failure must not repeat a photo exposure or start.
      return run(() => characteristic.writeValueWithResponse(bytes), 'Send Chakshu camera request');
    }
    async _request(op, offset = 0, path = '', signal) {
      const queue = this.context.mediaQueue || this.context.queue;
      const startedAt = Date.now();
      let stage = 'Find Chakshu camera controls',
        id;
      const run = (action, label) => {
        stage = label;
        return queue(async () => {
          signal?.throwIfAborted();
          const value = await action();
          signal?.throwIfAborted();
          return value;
        }, label);
      };
      try {
        signal?.throwIfAborted();
        this.command ||= await run(
          () => this.context.service.getCharacteristic(COMMAND),
          'Find Chakshu camera controls',
        );
        this.data ||= await run(
          () => this.context.service.getCharacteristic(DATA),
          'Find Chakshu camera data',
        );
        const name = new TextEncoder().encode(path);
        if (name.length > 63) throw Error('Invalid camera file path.');
        const bytes = new Uint8Array(10 + name.length),
          v = new DataView(bytes.buffer);
        id = ++this.id;
        bytes[0] = 0xca;
        bytes[1] = op;
        v.setUint32(2, id, true);
        v.setUint32(6, offset, true);
        bytes.set(name, 10);
        await this.writeCommand(run, bytes);
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          const reply = decode(
            await run(() => this.data.readValue(), 'Read Chakshu camera response'),
            id,
          );
          if (reply) return reply;
          await delay(60);
        }
        throw Error('Camera request timed out. Reconnect and refresh its status.');
      } catch (reason) {
        const error =
          root.SynapBluetoothSession?.normalizeError(reason) ||
          (reason && typeof reason.message === 'string'
            ? reason
            : new Error(
                typeof reason === 'string' && reason ? reason : 'Camera Bluetooth request failed.',
              ));
        if (error.name !== 'AbortError')
          root.dispatchEvent?.(
            new CustomEvent('synap-capture-diagnostic', {
              detail: {
                operation: op,
                stage,
                requestId: id,
                offset,
                elapsedMs: Date.now() - startedAt,
                message: error.message,
              },
            }),
          );
        throw error;
      }
    }
    bytes(op, path, signal, progress = () => {}) {
      return this.serialize(() => this._bytes(op, path, signal, progress));
    }
    async _bytes(op, path, signal, progress = () => {}) {
      const first = await this._request(op, 0, path, signal),
        limit = op === 1 ? 250000 : 32 * 1024 * 1024;
      if (!first.total || first.total > limit)
        throw Error('Camera file exceeds this transfer limit. Import it from the SD card.');
      const parts = [];
      let size = 0;
      const readOp = op === 1 ? 2 : 4;
      while (size < first.total) {
        const reply = await this._request(readOp, size, '', signal);
        if (
          reply.total !== first.total ||
          reply.offset !== size ||
          !reply.bytes.length ||
          size + reply.bytes.length > first.total
        )
          throw Error('Camera transfer changed. Retry the import.');
        parts.push(reply.bytes);
        size += reply.bytes.length;
        progress(size / first.total);
      }
      return new Blob(parts, { type: op === 1 ? 'image/jpeg' : 'application/octet-stream' });
    }
    snapshot(signal) {
      return this.bytes(1, '', signal);
    }
    file(path, signal, progress) {
      if (!/^\/synap\/[a-f0-9]{8}-[a-f0-9]{8}\.(jpg|wav|mjpeg|json)$/.test(path))
        throw Error('Invalid SD path.');
      return this.bytes(3, path, signal, progress);
    }
    catalogue(signal) {
      return this.serialize(async () => {
        await this._request(7, 0, '', signal);
        const blob = await this._bytes(8, '', signal);
        return JSON.parse(await blob.text());
      });
    }
  }
  root.SynapChakshuTransfer = { Client, decode, revision: '1.0.0-chakshu-transport5' };
  if (typeof module !== 'undefined') module.exports = root.SynapChakshuTransfer;
})(globalThis);
