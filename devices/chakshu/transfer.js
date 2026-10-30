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
    RESPONSE_DEADLINE_MS = 30000,
    // Native FAT full-card format at the C3's conservative SD clock is slow.
    // Never send a duplicate format when the BLE reply is merely delayed.
    C3_SD_FORMAT_DEADLINE_MS = 600000;
  const delay = (ms) => new Promise((resolve) => root.setTimeout(resolve, ms));
  // Every media client on a GATT link shares ONE firmware command/response
  // slot. Serializing native ATT calls alone cannot protect a multi-step
  // catalogue/read/notification transaction against a second Client.
  // Weak keys let old link queues be collected after disconnect.
  const linkTransactions = new WeakMap();
  // The firmware has one response characteristic per link. A newly constructed
  // Client must not reuse a previous Client's request ID: a delayed command
  // could otherwise accept the previous reply as if it were its own.
  const linkRequestIds = new WeakMap();
  function nextRequestId(context) {
    const next = ((linkRequestIds.get(context) || 0) + 1) >>> 0 || 1;
    linkRequestIds.set(context, next);
    return next;
  }
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
  function sdSyncCrc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  class MediaWindow {
    constructor(id, offset, total, maxChunks = 8, sdWindow = false, compressed = false) {
      Object.assign(this, { id, offset, total, maxChunks, sdWindow, compressed, ended: false, chunks: new Map() });
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
      let kind = value.getUint8(2);
      const error = value.getUint8(3),
        total = value.getUint32(8, true),
        offset = value.getUint32(12, true);
      let size = value.byteLength - 16;
      let bytes;
      if (kind === 3 && !error) {
        if (!this.compressed || value.byteLength !== 426 || !root.SynapAudioCodecV3?.decodeFrame)
          throw Error('Unexpected compressed SD block.');
        const samples = value.getUint16(16, true);
        const packet = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (!samples || samples > 800 || offset < 44 || (offset - 44) % 2 ||
            sdSyncCrc32(packet.subarray(0, 422)) !== value.getUint32(422, true))
          throw Error('Compressed SD block failed integrity verification. Original retained.');
        bytes = root.SynapAudioCodecV3.decodeFrame(packet.subarray(18, 422)).slice(0, samples * 2);
        size = bytes.length;
        this.receivedCompressed = true;
        kind = 1;
      }
      if (error) {
        const failure = Error(this.sdWindow
          ? 'SD read failed during Bluetooth sync. Preserve the original recording; do not format or delete the card.'
          : 'SD or camera data became unavailable during transfer.');
        failure.mediaCode = error;
        if (this.sdWindow) failure.sdReadFailure = true;
        throw failure;
      }
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
      if (kind !== 1 || !size || size > (bytes ? 1600 : 480)) throw Error('Invalid camera notification.');
      bytes ||= new Uint8Array(value.buffer, value.byteOffset + 16, size).slice();
      const previous = this.chunks.get(offset);
      if (previous && (previous.length !== size || previous.some((v, i) => v !== bytes[i])))
        throw Error('Conflicting camera notification.');
      if (!previous && this.chunks.size >= this.maxChunks) throw Error('Camera credit window exceeded.');
      for (const [start, data] of this.chunks)
        if (start !== offset && start < offset + size && offset < start + data.length)
          throw Error('Overlapping camera notification.');
      this.chunks.set(offset, bytes);
      return true;
    }
    creditComplete(credits) {
      // Each notification is offset-verified. A full contiguous credit grant
      // may finish without waiting for the additional END notification.
      return this.chunks.size === credits && this.contiguous().parts.length === credits;
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
      this.operations = Promise.resolve();
      this.command = null;
      this.data = null;
      this.stream = null;
      this.streamDisabled = false;
      // Per-link receiver credits, never persisted across BLE reconnections.
      this.fastCredits = 8;
      this.fastWindowFailures = 0;
      this.fastDisabled = false; // Older six-credit op12 after repeated packet loss.
      this.fastPaceMs = 15;
      this.pcmHeadroomCleanWindows = 0;
      this.pcmHeadroomBlocked = false;
      this.fastGoodWindows = 0;
      this.fastLossHoldWindows = 0;
      // Bluefy can lose a window every few otherwise successful windows. The
      // old consecutive-failure threshold never caught that recurring loss.
      this.compactLossEvents = 0;
      this.compactCleanWindows = 0;
      this.compactCreditGoodWindows = 0;
      // Field Bluefy: 12 credits at 8 ms repeatedly loses notifications.
      // Keep media-v3 <=10 credits and >=10 ms; media-v2 is unchanged.
      this.compactCreditCeiling = 10;
    }
    get features() {
      return (
        this.context.mediaFeatures ??
        (root.SynapModules?.client?.context === this.context
          ? root.SynapModules.client.module?.mediaFeatures || 0
          : 0)
      );
    }
    get adaptiveSupported() {
      const info = this.context.module ||
        (root.SynapModules?.client?.context === this.context ? root.SynapModules.client.module : null);
      return info?.id === 2 && info.mediaVersion >= 2 && Boolean(this.features & 0x40);
    }
    get compactSupported() {
      // Media-v3 only. The firmware validates the original file selection
      // token and BLE connection before serving any compact read.
      const info = this.context.module ||
        (root.SynapModules?.client?.context === this.context ? root.SynapModules.client.module : null);
      return info?.id === 2 && info.mediaVersion >= 3 && Boolean(this.features & 0x40);
    }
    get compressedSupported() {
      // Offline sync always preserves PCM samples. Never request opcode36.
      return false;
    }
    get reliableC3SdMode() {
      const info = this.context.module ||
        (root.SynapModules?.client?.context === this.context ? root.SynapModules.client.module : null);
      // Only the SD-specific media-v4 tracks opt into existing lossless op31.
      // Other C3 firmware retains its conservative six-packet path.
      return info?.id === 2 && info.mediaVersion !== 4;
    }
    get fasterPcmRamp() {
      const info = this.context.module ||
        (root.SynapModules?.client?.context === this.context ? root.SynapModules.client.module : null);
      return info?.id === 2 && info.mediaVersion === 4;
    }
    // Media-v2/3 remains read-only; older C3 builds use opcode30 unchanged.
    adaptWindow(complete, short, credits, elapsedMs, hasMore, adaptive) {
      if (!complete || short) {
        this.pcmHeadroomCleanWindows = 0;
        this.pcmHeadroomBlocked = true;
        this.fastCredits = Math.max(6, Math.floor(credits / 2));
        this.fastGoodWindows = 0;
        this.fastPaceMs = 15;
        // Avoid returning to lossy 8ms after just a few clean windows.
        if (adaptive && this.compactSupported) {
          this.fastLossHoldWindows = 24;
          this.compactCreditGoodWindows = 0;
          this.compactCleanWindows = 0;
          // Fall back to proven six-credit op12 after three *intermittent*
          // losses, not just three adjacent lost windows. Read-only, same
          // verified file and next contiguous offset.
          if (++this.compactLossEvents >= 3) this.fastDisabled = true;
        }
        if (++this.fastWindowFailures >= 3) this.fastDisabled = true;
        return;
      }
      // A fresh C3+SD connection must prove sustained clean delivery before
      // probing 9 ms. Any missing data disables this probe for this Client.
      if (adaptive && this.fasterPcmRamp && !this.pcmHeadroomBlocked &&
          this.fastPaceMs <= 10 && credits === 10 && elapsedMs < 1500 && hasMore) {
        if (++this.pcmHeadroomCleanWindows >= 64) this.fastPaceMs = 9;
      } else this.pcmHeadroomCleanWindows = 0;
      this.fastWindowFailures = 0;
      if (adaptive && this.compactSupported && this.compactLossEvents &&
          ++this.compactCleanWindows >= 24) {
        --this.compactLossEvents;
        this.compactCleanWindows = 0;
      }
      if (adaptive && this.compactSupported && this.fastLossHoldWindows > 0) {
        --this.fastLossHoldWindows;
        this.fastPaceMs = 15;
        this.fastGoodWindows = 0;
      }
      if (elapsedMs < 1500 && hasMore) {
        if (adaptive && this.compactSupported) {
          // Slow-start at four clean windows per extra credit. Jumping from
          // 8 to 12 credits in four windows previously outran Bluefy.
          if (++this.compactCreditGoodWindows >= (this.fasterPcmRamp ? 2 : 4)) {
            this.fastCredits = Math.min(this.compactCreditCeiling, credits + 1);
            this.compactCreditGoodWindows = 0;
          }
        } else this.fastCredits = Math.min(12, credits + 1);
      }
      if (adaptive && (!this.compactSupported || this.fastLossHoldWindows === 0) &&
          this.fastCredits >= (this.compactSupported ? this.compactCreditCeiling : 12) &&
          elapsedMs < 1500 && hasMore && ++this.fastGoodWindows >= (this.fasterPcmRamp ? 4 : 8)) {
        // Media-v3 stabilizes at 10 ms: 8 ms repeatedly outran Bluefy.
        this.fastPaceMs = this.compactSupported
          ? (this.fastPaceMs >= 15 ? 12 : this.fasterPcmRamp && this.fastPaceMs === 9 ? 9 : 10)
          : (this.fastPaceMs >= 15 ? 12 : this.fastPaceMs >= 12 ? 10 : 8);
        this.fastGoodWindows = 0;
      }
    }
    serialize(action) {
      // Device-scoped transaction lease, shared across ALL Client instances.
      // Without this, background SD catalogue and foreground verified sync
      // can reuse request IDs and overwrite the firmware's sole response slot.
      // Individual ATT calls still use the app's native queue, permitting
      // high-priority BLE audio/control work between SD read chunks.
      const previous = linkTransactions.get(this.context) || Promise.resolve();
      const operation = previous.then(action);
      const settled = operation.catch(() => {});
      linkTransactions.set(this.context, settled);
      this.operations = settled;
      return operation;
    }
    request(op, offset = 0, path = '', signal) {
      return this.serialize(() => this._request(op, offset, path, signal));
    }
    async writeCommand(run, bytes) {
      const characteristic = this.command,
        properties = characteristic.properties || {},
        // C3 reuses the historical camera media UUIDs; diagnostic names must
        // identify the actual target when a native Bluefy write fails.
        label = (this.context.module?.id === 2 ||
          root.SynapModules?.client?.module?.id === 2)
          ? 'Send C3 SD media request' : 'Send Chakshu camera request';
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
          label,
        );
      // An ambiguous write failure must not repeat a photo exposure or start.
      return run(() => characteristic.writeValueWithResponse(bytes), label);
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
    async sendOnly(op, offset, signal, id = nextRequestId(this.context), path = '', credits = 6, paceMs = 15, sessionToken = 0) {
      // Op30 uses the existing credit byte. Optional op31 adds a second
      // 8-15ms pacing byte. Legacy op12 and Chakshu remain unchanged.
      const pathBytes = path ? new TextEncoder().encode(path) : new Uint8Array();
      if (pathBytes.length > 63) throw Error('Invalid SD transfer path.');
      const compact = (op === 31 || op === 36) && !path && Number.isInteger(sessionToken) && sessionToken > 0;
      const adaptive = op === 31 && Boolean(path || compact);
      const fast = (op === 30 && Boolean(path)) || adaptive;
      const prefix = compact ? 16 : adaptive ? 12 : fast ? 11 : 10;
      const bytes = new Uint8Array(prefix + pathBytes.length),
        view = new DataView(bytes.buffer);
      bytes[0] = 0xca;
      bytes[1] = op;
      view.setUint32(2, id, true);
      view.setUint32(6, offset, true);
      if (fast) bytes[10] = Math.max(6, Math.min(12, credits));
      if (adaptive) bytes[11] = Math.max(8, Math.min(15, paceMs));
      if (compact) view.setUint32(12, sessionToken, true);
      if (pathBytes.length) bytes.set(pathBytes, prefix);
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
    async window(offset, total, signal, path = '', sessionToken = 0, prefetch = null) {
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
      const compressed = Boolean(path) && this.compressedSupported && Number.isInteger(sessionToken) && sessionToken > 0;
      const fast = Boolean(path) && Boolean(this.features & 0x40) && !this.fastDisabled && !this.reliableC3SdMode;
      const adaptive = fast && this.adaptiveSupported;
      const compact = adaptive && this.compactSupported && Number.isInteger(sessionToken) && sessionToken > 0;
      const paceMs = adaptive ? this.fastPaceMs : 15;
      const credits = fast ? Math.max(6, Math.min(compact ? this.compactCreditCeiling : 12, this.fastCredits)) : 6;
      const began = Date.now();
      const id = nextRequestId(this.context),
        window = new MediaWindow(id, offset, total, fast ? 12 : 8, Boolean(path), compressed);
      let timer, finish, fail;
      let commandMs = 0, notificationWaitMs = 0, prefetched = false;
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
          if (!window.accept(event.target.value)) return;
          // One bounded read ahead, only after a stable, contiguous grant.
          // The worker serializes SD access; each window has its own request ID.
          if (!prefetched && prefetch && this.fasterPcmRamp && compact &&
              credits === 10 && paceMs <= 10 && !this.fastLossHoldWindows &&
              window.chunks.size === credits - 2 &&
              window.contiguous().next === offset + (credits - 2) * 480 &&
              offset + credits * 480 < total) {
            prefetched = true;
            prefetch(offset + credits * 480);
          }
          if (window.ended || ((fast || compressed) && window.creditComplete(credits))) finish();
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
        const commandStarted = Date.now();
        await this.sendOnly(compressed ? 36 : fast ? (adaptive ? 31 : 30) : 12, offset, signal, id, (compact || compressed) ? '' : path, credits, paceMs, (compact || compressed) ? sessionToken : 0);
        commandMs = Date.now() - commandStarted;
        signal?.throwIfAborted();
        const notificationsStarted = Date.now();
        // An incomplete foreground v3 window can otherwise burn three seconds
        // waiting for an END packet that the phone never received. Legacy
        // firmware and backgrounded browsers retain the generous watchdog.
        const timeoutMs = compact && root.document?.visibilityState === 'visible'
          ? 1600 : 3000;
        const timeoutDueAt = Date.now() + timeoutMs;
        timer = setTimeout(finish, timeoutMs);
        await done;
        notificationWaitMs = Date.now() - notificationsStarted;
        const result = window.contiguous();
        if (fast) {
          const complete = (window.ended || window.creditComplete(credits)) &&
            result.parts.length === window.chunks.size;
          const short = result.next < total && result.parts.length < credits;
          // Missing offsets immediately restore 15ms; three consecutive
          // failures disable fast mode, preserving the legacy SD read path.
          this.adaptWindow(complete, short, credits, Date.now() - began,
            result.next < total, adaptive);
          // Keep Bluefy's main thread responsive; log at 256 KiB boundaries
          // or on recovery instead of one diagnostic for every 4–10 KiB.
          if (!complete || short || Math.floor(offset / 262144) !== Math.floor(result.next / 262144))
            root.dispatchEvent?.(new CustomEvent('synap-capture-diagnostic', {
              detail: { operation: adaptive ? 31 : 30, stage: 'BLE SD window backpressure',
                paceMs, nextPaceMs: this.fastPaceMs, mediaVersion: adaptive ? (compact ? 3 : 2) : 1,
                compact, visibility: root.document?.visibilityState || 'unknown',
                timeoutMs, speedHoldWindows: this.fastLossHoldWindows,
                timeoutOvershootMs: Math.max(0, Date.now() - timeoutDueAt),
                offset, next: result.next, credits, received: result.parts.length,
                elapsedMs: Date.now() - began, commandMs, notificationWaitMs,
                payloadBytes: result.next - offset,
                rateBytesPerSecond: Math.round((result.next - offset) * 1000 / Math.max(1, Date.now() - began)),
                interrupted: !complete || short,
                fallbackToLegacy: this.fastDisabled, compactLossEvents: this.compactLossEvents },
            }));
        }
        return { ...result, compressed: compressed && Boolean(window.receivedCompressed) };
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
        id = nextRequestId(this.context);
        bytes[0] = 0xca;
        bytes[1] = op;
        v.setUint32(2, id, true);
        v.setUint32(6, offset, true);
        bytes.set(name, 10);
        await this.writeCommand(run, bytes);
        const deadline = Date.now() + ((op === 19 || op === 33) ? C3_SD_FORMAT_DEADLINE_MS : RESPONSE_DEADLINE_MS);
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
          if (reply) return op === 3 && this.compactSupported
            ? { ...reply, sessionToken: id } : reply;
          await delay(op === 19 ? 750 : 60);
        }
        throw Error(op === 19
          ? 'SD format confirmation timed out. The device may still be formatting. Reconnect, check SD status, and do not immediately repeat Format.'
          : 'Camera request timed out. Reconnect and refresh its status.');
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
    // Private C3+SD SoftAP: these calls exchange only control/status over BLE.
    // Actual WAV downloads happen in the phone browser on the temporary AP.
    _c3ApStatus(signal) {
      return this._request(21, 0, '', signal).then(reply => {
        let state;
        try { state = JSON.parse(new TextDecoder().decode(reply.bytes)); }
        catch (_) { throw Error('C3 access point status is invalid.'); }
        if (!state || typeof state.active !== 'boolean') throw Error('C3 access point status is invalid.');
        if (state.active && (!/^Synap-C3-[0-9A-F]{4}$/.test(state.ssid) ||
            !/^[a-f0-9]{32}$/.test(state.password) ||
            !/^http:\/\/192\.168\.4\.1\/\?key=[a-f0-9]{32}$/.test(state.url)))
          throw Error('C3 hotspot details failed validation.');
        return state;
      });
    }
    c3ApStatus(signal) { return this.serialize(() => this._c3ApStatus(signal)); }
    startC3Ap(signal) {
      return this.serialize(async () => {
        const current=await this._c3ApStatus(signal);
        if(current.active)return current;
        // New C3 firmware returns hotspot credentials in op20 itself,
        // BEFORE Wi-Fi shares radio/heap with BLE. Never require an op21
        // GATT round trip after initiating radio handoff.
        const started=await this._request(20, 0, '', signal);
        let next=null;
        try { next=JSON.parse(new TextDecoder().decode(started.bytes)); }
        catch (_) { /* Earlier firmware returned only an empty op20 ACK. */ }
        if(next?.active) {
          if(!/^Synap-C3-[0-9A-F]{4}$/.test(next.ssid) ||
             !/^[a-f0-9]{32}$/.test(next.password) ||
             !/^http:\/\/192\.168\.4\.1\/\?key=[a-f0-9]{32}$/.test(next.url))
            throw Error('C3 hotspot credentials are invalid.');
          return next;
        }
        try { next=await this._c3ApStatus(signal); }
        catch (_) {
          throw Error('Bluetooth dropped during legacy hotspot start before Wi-Fi credentials arrived. Install firmware with staged C3 Wi-Fi handoff.');
        }
        if(!next.active)throw Error('C3 hotspot did not start. Check SD mount and battery.');
        return next;
      });
    }
    stopC3Ap(signal) {
      return this.serialize(async () => {
        await this._request(22, 0, '', signal);
        return {active:false,stopping:true};
      });
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
        stalls = 0,
        usedCompressed = false;
      let pendingWindow = null;
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
            // Never chain speculative reads: consume this one before granting more.
            let result;
            if (pendingWindow) {
              const pending = pendingWindow;
              pendingWindow = null;
              const outcome = await pending.promise;
              if (outcome.error) throw outcome.error;
              if (pending.offset === size) result = outcome.result;
              // A gap in the preceding window invalidates the read ahead.
              // Drain it before retrying so no old work survives file selection.
            }
            if (!result) result = await this.window(size, first.total, signal, c3WindowPath, first.sessionToken || 0,
              next => {
                pendingWindow = { offset: next, promise:
                  this.window(next, first.total, signal, c3WindowPath, first.sessionToken || 0)
                    .then(result => ({ result }), error => ({ error })) };
              });
            if (result.next > size) {
              usedCompressed ||= Boolean(result.compressed);
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
        // Drain any queued read before releasing the shared file-selection lock.
        if (pendingWindow) await pendingWindow.promise;
        if (signal?.aborted && this.stream) this.sendOnly(16, 0).catch(() => {});
      }
      const blob = new Blob(parts, { type: image ? 'image/jpeg' : 'application/octet-stream' });
      Object.defineProperty(blob, 'synapTransferEncoding', { value: usedCompressed ? 'ima-adpcm' : 'original' });
      return blob;
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
  root.SynapChakshuTransfer = { Client, MediaWindow, decode, revision: '1.0.0-chakshu-core19' };
  if (typeof module !== 'undefined') module.exports = root.SynapChakshuTransfer;
})(globalThis);
