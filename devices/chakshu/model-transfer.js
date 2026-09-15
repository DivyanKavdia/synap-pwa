/* Pinned model upload. The device acknowledges SD offsets on the shared GATT queue. */
(function (root) {
  'use strict';
  const SIZE = 2177224;
  const SHA256 = '9bb7348b31891a89eb494f5995970a7fc52b765759e4992d471ab2901bf9c47c';
  const URL = `https://raw.githubusercontent.com/DivyanKavdia/synap-firmware/ota-releases/models/${SHA256}/srmodels.bin`;
  const WRITE = '4fa12358-0000-1000-8000-00805f9b34fb';
  const STATUS = '4fa12359-0000-1000-8000-00805f9b34fb';
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [
    '',
    'Finish recording or the hardware check first.',
    'Insert an SD card and run Check hardware.',
    'Free some SD card space, then retry.',
    'SD write or read failed. Check the card and retry.',
    'Transfer offset changed. Retry the installation.',
    'Model verification failed. Retry the installation.',
    'Installation cancelled.',
    'Installation expired. Start again.',
    'Unsupported model upload packet.',
  ];
  function decode(v) {
    if (
      v?.byteLength !== 20 ||
      v.getUint8(0) !== 0xce ||
      v.getUint8(1) !== 1 ||
      v.getUint8(2) > 5 ||
      v.getUint32(12, true) !== SIZE ||
      v.getUint32(8, true) > SIZE ||
      v.getUint16(16, true) < 11 ||
      v.getUint16(16, true) > 480
    )
      throw Error('Update Chakshu firmware for this voice model.');
    return {
      state: v.getUint8(2),
      error: v.getUint8(3),
      session: v.getUint32(4, true),
      offset: v.getUint32(8, true),
      total: SIZE,
      maxData: v.getUint16(16, true),
      sd: Boolean(v.getUint8(18)),
      supported: Boolean(v.getUint8(19) & 1),
      embedded: Boolean(v.getUint8(19) & 2),
    };
  }
  async function verify(bytes) {
    if (bytes.byteLength !== SIZE) throw Error('Voice model download is incomplete. Retry.');
    const hash = Array.from(
      new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== SHA256) throw Error('Voice model integrity check failed. Retry the download.');
    return bytes;
  }
  async function download(signal) {
    const response = await root.fetch(URL, { signal, credentials: 'omit', cache: 'no-cache' });
    if (!response.ok)
      throw Error('Voice model download failed. Check the internet connection and retry.');
    // Bound the download before buffering untrusted content.
    const reader = response.body.getReader(),
      bytes = new Uint8Array(SIZE);
    let offset = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.length > SIZE) throw Error('Unexpected voice model size.');
        bytes.set(value, offset);
        offset += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (offset !== SIZE) throw Error('Voice model download is incomplete. Retry.');
    return verify(bytes);
  }
  class Client {
    constructor(context, check = () => {}) {
      this.context = context;
      this.check = check;
    }
    run(action) {
      this.check();
      return this.context.mediaQueue(async () => {
        this.check();
        const result = await action();
        this.check();
        return result;
      }, 'Install Chakshu voice model');
    }
    async connect() {
      try {
        this.write = await this.run(() => this.context.service.getCharacteristic(WRITE));
        this.status = await this.run(() => this.context.service.getCharacteristic(STATUS));
      } catch (e) {
        if (e.name === 'NotFoundError')
          throw Error('Update Chakshu firmware first to install the model through this app.');
        throw e;
      }
      return this.read();
    }
    async read() {
      return decode(await this.run(() => this.status.readValue()));
    }
    async send(op, id, offset = 0, data) {
      const bytes = new Uint8Array(data ? 9 + data.length : 5),
        v = new DataView(bytes.buffer);
      bytes[0] = op;
      v.setUint32(1, id, true);
      if (data) {
        v.setUint32(5, offset, true);
        bytes.set(data, 9);
      }
      await this.run(() => this.write.writeValueWithResponse(bytes));
    }
    async wait(id, predicate, signal, progress = () => {}) {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const status = await this.read();
        if (status.session === id) {
          progress(status);
          if (status.state === 4)
            throw Error(errors[status.error] || 'Voice model installation failed.');
          if (predicate(status)) return status;
        }
        await delay(60);
      }
      throw Error('Installation paused. Reconnect if needed, then press Resume installation.');
    }
    async install(bytes, signal, progress = () => {}) {
      signal?.throwIfAborted();
      let status = await this.read();
      if (status.embedded) {
        progress(status);
        return status;
      }
      await verify(bytes); // No BEGIN or SD writes before the browser validates the model.
      signal?.throwIfAborted();
      if (!status.supported) throw Error('Restart Chakshu to enable model installation.');
      if (!status.sd) throw Error(errors[2]);
      if (status.state === 3) {
        progress(status);
        return status;
      }
      const resume = [1, 2].includes(status.state);
      const id = resume ? status.session : root.crypto.getRandomValues(new Uint32Array(1))[0] || 1;
      await this.send(resume ? 6 : 1, id);
      status = await this.wait(id, (s) => [1, 2, 3].includes(s.state), signal, progress);
      while (status.state === 1 && status.offset < SIZE) {
        let offset = status.offset;
        // Four writes fit the firmware queue; wait for its cumulative SD ACK.
        for (let i = 0; i < 4 && offset < SIZE; i++) {
          signal?.throwIfAborted();
          const data = bytes.subarray(offset, Math.min(SIZE, offset + status.maxData));
          await this.send(2, id, offset, data);
          offset += data.length;
        }
        status = await this.wait(id, (s) => s.offset === offset, signal, progress);
      }
      if (status.state === 1) await this.send(3, id);
      return this.wait(id, (s) => s.state === 3, signal, progress);
    }
    async cancel() {
      const status = await this.read();
      if (![1, 2].includes(status.state)) return;
      await this.send(6, status.session);
      await this.send(5, status.session);
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const next = await this.read();
        if (![1, 2].includes(next.state)) return next;
        await delay(60);
      }
      throw Error('Could not confirm cancellation. Reconnect to check installation.');
    }
    async restart() {
      const status = await this.read();
      if (status.embedded) throw Error('The voice model is already included in Chakshu firmware.');
      if (status.state !== 3) throw Error('Finish installing the voice model first.');
      await this.send(4, status.session);
      return this.wait(status.session, (next) => {
        if (next.error) throw Error(errors[next.error]);
        return next.state === 5;
      });
    }
  }
  root.SynapChakshuModelTransfer = { SIZE, SHA256, URL, decode, verify, download, Client };
  if (typeof module !== 'undefined') module.exports = root.SynapChakshuModelTransfer;
})(globalThis);
