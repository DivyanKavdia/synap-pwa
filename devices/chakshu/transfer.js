/* Versioned request/response media transport on the app-owned Bluetooth queue. */
(function (root) {
  'use strict';
  const COMMAND = '4fa12354-0000-1000-8000-00805f9b34fb',
    DATA = '4fa12355-0000-1000-8000-00805f9b34fb',
    STREAM = '4fa1235a-0000-1000-8000-00805f9b34fb';
  // Large camera reads can outlast the recorder's short command deadline on
  // native browser bridges. Keep the read bounded and owned by the same queue;
  // cancellation never permits Stop to overlap an unresolved native operation.
  const READ_TIMEOUT_MS = 10000,
    C3_SD_READ_TIMEOUT_MS = 20000,
    RESPONSE_DEADLINE_MS = 30000;
  const delay = (ms) => new Promise((resolve) => root.setTimeout(resolve, ms));
  const hexText = (value) =>
    Array.from(new TextEncoder().encode(String(value ?? '')), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
    if (value.getUint8(2) !== 1) {
      const error = Error(
        [
          '',
          'Chakshu is busy.',
          'Unsupported media request.',
          'SD card unavailable.',
          'Camera unavailable.',
          'Microphone unavailable.',
          'SD card full.',
          'SD write/read failed.',
          'Capture failed.',
          'The SD card could not keep up. The partial recording was kept.',
          'Wi-Fi downloads could not start. Stop other activity and retry.',
          'SD file unavailable.',
        ][value.getUint8(3)] || 'Camera transfer failed.',
      );
      // New firmware includes bounded SD recovery details in failed replies.
      // Legacy 16-byte errors and malformed optional details remain readable.
      if ([3, 7].includes(value.getUint8(3)) && value.byteLength > 16 && value.byteLength <= 496) {
        try {
          const details = JSON.parse(new TextDecoder().decode(
            new Uint8Array(value.buffer, value.byteOffset + 16, value.byteLength - 16),
          ));
          if (details && typeof details === 'object' && !Array.isArray(details))
            error.storage = details;
        } catch (_) {}
      }
      error.mediaCode = value.getUint8(3);
      throw error;
    }
    return {
      total: value.getUint32(8, true),
      offset: value.getUint32(12, true),
      bytes: new Uint8Array(value.buffer, value.byteOffset + 16, value.byteLength - 16).slice(),
    };
  }
  class MediaWindow {
    constructor(id, offset, total) {
      Object.assign(this, { id, offset, total, ended: false, chunks: new Map() });
    }
    accept(value) {
      if (
        !value ||
        value.byteLength < 16 ||
        value.getUint8(0) !== 0xcc ||
        value.getUint8(1) !== 1 ||
        value.getUint32(4, true) !== this.id
      )
        return false;
      const kind = value.getUint8(2),
        error = value.getUint8(3),
        total = value.getUint32(8, true),
        offset = value.getUint32(12, true),
        size = value.byteLength - 16;
      if (error) throw Error('SD or camera data became unavailable during transfer.');
      // An empty window can yield to audio before the firmware reads the file.
      if (kind === 2 && total === 0 && offset === this.offset && size === 0) {
        this.ended = true;
        return true;
      }
      if (total !== this.total || offset < this.offset || offset > total || size > total - offset)
        throw Error('Camera transfer changed. Retry the import.');
      if (kind === 2 && !size) {
        this.ended = true;
        return true;
      }
      if (kind !== 1 || !size || size > 480) throw Error('Invalid camera notification.');
      const bytes = new Uint8Array(value.buffer, value.byteOffset + 16, size).slice(),
        previous = this.chunks.get(offset);
      if (previous && (previous.length !== size || previous.some((v, i) => v !== bytes[i])))
        throw Error('Conflicting camera notification.');
      if (!previous && this.chunks.size >= 8) throw Error('Camera credit window exceeded.');
      for (const [start, data] of this.chunks)
        if (start !== offset && start < offset + size && offset < start + data.length)
          throw Error('Overlapping camera notification.');
      this.chunks.set(offset, bytes);
      return true;
    }
    contiguous() {
      let next = this.offset;
      const parts = [];
      while (this.chunks.has(next)) {
        const bytes = this.chunks.get(next);
        parts.push(bytes);
        next += bytes.length;
      }
      return { parts, next };
    }
  }
  class Client {
    constructor(context) {
      this.context = context;
      this.id = 0;
      this.operations = Promise.resolve();
      this.command = null;
      this.data = null;
      this.stream = null;
      this.streamDisabled = false;
    }
    get features() {
      return (
        this.context.mediaFeatures ??
        (root.SynapModules?.client?.context === this.context
          ? root.SynapModules.client.module?.mediaFeatures || 0
          : 0)
      );
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
    async subscribeStream(signal) {
      if (this.stream) return;
      const queue = this.context.mediaQueue || this.context.queue;
      const stream = await queue(
        () => this.context.service.getCharacteristic(STREAM),
        'Find Chakshu camera notifications',
      );
      signal?.throwIfAborted();
      await queue(() => stream.startNotifications(), 'Subscribe to Chakshu camera notifications');
      signal?.throwIfAborted();
      this.stream = stream;
    }
    async sendOnly(op, offset, signal, id = ++this.id, path = '') {
      // C3 notification windows include their WAV path to prevent a background
      // catalogue/other client from silently switching the selected source.
      const pathBytes = path ? new TextEncoder().encode(path) : new Uint8Array();
      if (pathBytes.length > 63) throw Error('Invalid SD transfer path.');
      const bytes = new Uint8Array(10 + pathBytes.length),
        view = new DataView(bytes.buffer);
      bytes[0] = 0xca;
      bytes[1] = op;
      view.setUint32(2, id, true);
      view.setUint32(6, offset, true);
      if (pathBytes.length) bytes.set(pathBytes, 10);
      const queue = this.context.mediaQueue || this.context.queue;
      await this.writeCommand(
        (action, label) =>
          queue(async () => {
            signal?.throwIfAborted();
            return action();
          }, label),
        bytes,
      );
      return id;
    }
    async window(offset, total, signal, path = '') {
      signal?.throwIfAborted();
      try {
        await this.subscribeStream(signal);
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError' || error.name === 'TimeoutError')
          throw error;
        // A browser may retain its old GATT characteristic cache across an OTA
        // update or reject a second subscription. Read this same exposure instead.
        this.streamDisabled = true;
        return { parts: [], next: offset };
      }
      const id = ++this.id,
        window = new MediaWindow(id, offset, total);
      let timer, finish, fail;
      const done = new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      // A bridge can deliver notifications while its write promise is pending.
      // Attach first and consume rejection immediately; always retain the write's
      // native queue ownership until it settles.
      done.catch(() => {});
      const receive = (event) => {
        try {
          if (window.accept(event.target.value) && window.ended) finish();
        } catch (error) {
          fail(error);
        }
      };
      const abort = () =>
        fail(signal.reason || new DOMException('Capture cancelled.', 'AbortError'));
      const disconnect = () => fail(Error('Pendant connection changed.'));
      this.stream.addEventListener('characteristicvaluechanged', receive);
      signal?.addEventListener('abort', abort, { once: true });
      root.addEventListener?.('synap-gatt-disconnected', disconnect, { once: true });
      try {
        await this.sendOnly(12, offset, signal, id, path);
        signal?.throwIfAborted();
        timer = setTimeout(finish, 3000);
        await done;
        return window.contiguous();
      } finally {
        clearTimeout(timer);
        this.stream.removeEventListener('characteristicvaluechanged', receive);
        signal?.removeEventListener('abort', abort);
        root.removeEventListener?.('synap-gatt-disconnected', disconnect);
      }
    }
    async _request(op, offset = 0, path = '', signal) {
      const queue = this.context.mediaQueue || this.context.queue;
      const startedAt = Date.now();
      let stage = 'Find Chakshu camera controls',
        id;
      const run = (action, label, options) => {
        stage = label;
        return queue(
          async () => {
            signal?.throwIfAborted();
            const value = await action();
            signal?.throwIfAborted();
            return value;
          },
          label,
          options,
        );
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
        const deadline = Date.now() + RESPONSE_DEADLINE_MS;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          const reply = decode(
            await run(() => this.data.readValue(), op === 7 ?
              (root.SynapModules?.client?.module?.id === 2 ? 'Read C3 SD catalogue response' : 'Read Chakshu SD catalogue response') :
              'Read Chakshu camera response', {
              timeoutMs:
                root.SynapModules?.client?.module?.id === 2
                  ? C3_SD_READ_TIMEOUT_MS
                  : READ_TIMEOUT_MS,
            }),
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
                ...(Number.isInteger(reason?.mediaCode) ? { mediaCode: reason.mediaCode } : {}),
                ...(reason?.storage ? { storage: reason.storage } : {}),
              },
            }),
          );
        throw error;
      }
    }
    async _sendC3Config(text, mode, signal) {
      const ascii = String(text || '');
      if (!ascii || ascii.length > 2200) throw Error('Wi-Fi configuration is too large.');
      let offset = 0;
      while (offset < ascii.length) {
        signal?.throwIfAborted();
        const chunk = ascii.slice(offset, offset + 60);
        const reply = await this._request(23, offset, chunk, signal);
        if (reply.total !== offset + chunk.length) throw Error('Wi-Fi configuration transfer changed.');
        offset += chunk.length;
      }
      return this._request(24, mode, '', signal);
    }
    configureC3Wifi(ssid, password, signal) {
      return this.serialize(async () => {
        const ssidBytes = new TextEncoder().encode(String(ssid || '')),
          passwordBytes = new TextEncoder().encode(String(password || ''));
        if (!ssidBytes.length || ssidBytes.length > 32) throw Error('Wi-Fi name must be 1–32 bytes.');
        if (passwordBytes.length > 63) throw Error('Wi-Fi password must be 63 bytes or fewer.');
        await this._sendC3Config('S=' + hexText(ssid) + '\nP=' + hexText(password) + '\n', 1, signal);
        return this._c3WifiStatus(signal);
      });
    }
    startC3WifiUpload(options, signal) {
      return this.serialize(async () => {
        const endpoint = String(options?.endpoint || '').replace(/\/+$/, ''),
          token = String(options?.token || ''),
          recordingId = String(options?.recordingId || ''),
          path = String(options?.path || '');
        if (!/^https:\/\/[^/?#@]+(?::\d+)?$/i.test(endpoint))
          throw Error('Synap Wi-Fi upload endpoint is invalid.');
        if (!token || token.length > 800) throw Error('Synap Wi-Fi upload ticket is invalid.');
        if (!/^[0-9a-f-]{36}$/i.test(recordingId)) throw Error('Synap recording ID is invalid.');
        if (!/^\/synap\/[a-z0-9][a-z0-9._-]{0,51}\.wav$/i.test(path))
          throw Error('Invalid SD recording path.');
        const text =
          'E=' + hexText(endpoint) + '\n' +
          'T=' + hexText(token) + '\n' +
          'R=' + hexText(recordingId) + '\n' +
          'F=' + hexText(path) + '\n';
        await this._sendC3Config(text, 2, signal);
        return this._c3WifiStatus(signal);
      });
    }
    _c3WifiStatus(signal) {
      return this._request(25, 0, '', signal).then((reply) => {
        try {
          const status = JSON.parse(new TextDecoder().decode(reply.bytes));
          if (!status || typeof status !== 'object') throw Error();
          return status;
        } catch (_) {
          throw Error('Pendant Wi-Fi status could not be read.');
        }
      });
    }
    c3WifiStatus(signal) {
      return this.serialize(() => this._c3WifiStatus(signal));
    }
    forgetC3Wifi(signal) {
      return this.serialize(async () => {
        await this._request(26, 0, '', signal);
        return this._c3WifiStatus(signal);
      });
    }
    bytes(op, path, signal, progress = () => {}, preview = false) {
      return this.serialize(() => this._bytes(op, path, signal, progress, preview));
    }
    async _bytes(op, path, signal, progress = () => {}, preview = false) {
      const first = await this._request(op, op === 1 && preview ? 1 : 0, path, signal),
        image = op === 1 || op === 13,
        // C3 SD audio needs more than the Chakshu camera's 32 MiB ceiling.
        // Keep a bounded memory cap for iOS; larger recordings need segmented transfer.
        limit = image ? 250000 :
          (root.SynapModules?.client?.module?.id === 2 && /\.wav$/i.test(path)
            ? 64 * 1024 * 1024 : 32 * 1024 * 1024);
      if (!first.total || first.total > limit)
        throw Error('Camera file exceeds this transfer limit. Import it from the SD card.');
      progress(0, first.total);
      const parts = [];
      let size = 0,
        stalls = 0;
      const readOp = image ? 2 : 4,
        // Only the C3 uses explicit-path notification requests; Chakshu's
        // existing 10-byte window protocol is unchanged.
        c3WindowPath = op === 3 && /\.wav$/i.test(path) &&
          (this.context.module?.id === 2 || root.SynapModules?.client?.module?.id === 2) ? path : '',
        // SD reads must be self-describing. Multiple Client instances can share
        // one firmware worker; a background catalogue must never replace the
        // foreground file selection between chunks.
        readPath = image ? '' : op === 8 ? '@catalogue' : path;
      try {
        while (size < first.total) {
          signal?.throwIfAborted();
          if (this.features & 1 && !this.streamDisabled) {
            const result = await this.window(size, first.total, signal, c3WindowPath);
            if (result.next > size) {
              parts.push(...result.parts);
              size = result.next;
              stalls = 0;
              progress(size / first.total, first.total);
              continue;
            }
            if (++stalls < 3) continue;
            // A browser which cannot deliver camera notifications can still read
            // the same selected exposure. Do not recapture or lose its SD original.
            this.streamDisabled = true;
            await this.sendOnly(16, 0, signal);
          }
          const reply = await this._request(readOp, size, readPath, signal);
          if (
            reply.total !== first.total ||
            reply.offset !== size ||
            !reply.bytes.length ||
            size + reply.bytes.length > first.total
          )
            throw Error('Camera transfer changed. Retry the import.');
          parts.push(reply.bytes);
          size += reply.bytes.length;
          progress(size / first.total, first.total);
        }
      } finally {
        if (signal?.aborted && this.stream) this.sendOnly(16, 0).catch(() => {});
      }
      return new Blob(parts, { type: image ? 'image/jpeg' : 'application/octet-stream' });
    }
    snapshot(signal, progress, preview = false) {
      return this.bytes(1, '', signal, progress, preview);
    }
    savedPreview(signal, progress) {
      return this.serialize(async () => {
        const blob = await this._bytes(13, '', signal, progress);
        const reply = await this._request(15, 0, '', signal);
        const path = new TextDecoder().decode(reply.bytes);
        if (!/^\/synap\/[a-f0-9]{8}-[a-f0-9]{8}\.jpg$/.test(path))
          throw Error('The saved photo path could not be verified. Check the SD card.');
        return { blob, path };
      });
    }
    file(path, signal, progress) {
      if (
        !/^\/synap\/(?:[a-f0-9]{8}-[a-f0-9]{8}\.(?:jpg|wav|mjpeg|json)|[a-z0-9][a-z0-9._-]{0,51}\.wav)$/i.test(path)
      )
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
  root.SynapChakshuTransfer = { Client, MediaWindow, decode, revision: '1.0.0-chakshu-core18' };
  if (typeof module !== 'undefined') module.exports = root.SynapChakshuTransfer;
})(globalThis);
