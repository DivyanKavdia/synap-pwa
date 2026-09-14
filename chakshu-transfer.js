/* Versioned request/response media transport on the app-owned Bluetooth queue. */
(function (root) {
  'use strict';
  const COMMAND = '4fa12354-0000-1000-8000-00805f9b34fb',
    DATA = '4fa12355-0000-1000-8000-00805f9b34fb';
  const delay = (ms) => new Promise((resolve) => root.setTimeout(resolve, ms));
  function decode(value, id) {
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
      this.pending = false;
      this.command = null;
      this.data = null;
    }
    async request(op, offset = 0, path = '', signal) {
      if (this.pending) throw Error('Wait for the current media transfer.');
      this.pending = true;
      const queue = this.context.mediaQueue || this.context.queue;
      const run = (action) => queue(action, 'Chakshu camera transfer');
      try {
        signal?.throwIfAborted();
        this.command ||= await run(() => this.context.service.getCharacteristic(COMMAND));
        this.data ||= await run(() => this.context.service.getCharacteristic(DATA));
        const name = new TextEncoder().encode(path);
        if (name.length > 63) throw Error('Invalid camera file path.');
        const bytes = new Uint8Array(10 + name.length),
          v = new DataView(bytes.buffer),
          id = ++this.id;
        bytes[0] = 0xca;
        bytes[1] = op;
        v.setUint32(2, id, true);
        v.setUint32(6, offset, true);
        bytes.set(name, 10);
        await run(() => this.command.writeValueWithResponse(bytes));
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          const reply = decode(await run(() => this.data.readValue()), id);
          if (reply) return reply;
          await delay(60);
        }
        throw Error('Camera request timed out. Reconnect and refresh its status.');
      } finally {
        this.pending = false;
      }
    }
    async bytes(op, path, signal, progress = () => {}) {
      const first = await this.request(op, 0, path, signal),
        limit = op === 1 ? 250000 : 32 * 1024 * 1024;
      if (!first.total || first.total > limit)
        throw Error('Camera file exceeds this transfer limit. Import it from the SD card.');
      const parts = [];
      let size = 0;
      const readOp = op === 1 ? 2 : 4;
      while (size < first.total) {
        const reply = await this.request(readOp, size, '', signal);
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
    async catalogue(signal) {
      await this.request(7, 0, '', signal);
      const blob = await this.bytes(8, '', signal);
      return JSON.parse(await blob.text());
    }
  }
  root.SynapChakshuTransfer = { Client, decode };
  if (typeof module !== 'undefined') module.exports = root.SynapChakshuTransfer;
})(globalThis);
