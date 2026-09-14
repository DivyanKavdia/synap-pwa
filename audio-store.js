/* Synap browser journal and resilient processing queue.
 * Durable recording storage stays in the PWA; pendant recovery buffers are volatile.
 */
(function (root) {
  'use strict';
  const SEGMENT_FRAMES = 600; // 30 seconds at 50 ms/frame.
  const PCM_BYTES_PER_FRAME = 1600;
  const MAX_BUFFER_PACKETS = 1600;
  const ZERO_FRAME = new Uint8Array(PCM_BYTES_PER_FRAME);

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function enqueueJob(store, job) {
    const existing = store.index('dedupe').get(job.dedupe);
    existing.onsuccess = () => {
      if (!existing.result) store.add(job);
    };
  }
  function audioError(detail) {
    return Object.assign(
      new Error('Audio data is damaged (' + detail + '). Keep the original for recovery.'),
      {
        code: 'audio_integrity',
        retryable: false,
      },
    );
  }
  function pcmBytes(frames, frameBytes = 2) {
    let bytes = 0;
    for (const frame of frames) {
      if (
        !(ArrayBuffer.isView(frame) || frame instanceof ArrayBuffer) ||
        frame.byteLength % frameBytes ||
        (frameBytes > 2 && frame.byteLength !== frameBytes)
      ) {
        throw audioError('incomplete PCM sample or frame');
      }
      bytes += frame.byteLength;
    }
    if (!Number.isSafeInteger(bytes) || bytes > 0xffffffff - 36) throw audioError('WAV size limit');
    return bytes;
  }
  // Read only chunk headers. Validation must stay bounded for long recordings
  // and must never silently drop a byte or guess how damaged PCM was aligned.
  async function validateWav(blob) {
    if (!(blob instanceof Blob) || blob.size < 44) throw audioError('invalid WAV header');
    const tag = (view, at) => view.getUint32(at, false);
    const riff = new DataView(await blob.slice(0, 12).arrayBuffer());
    if (tag(riff, 0) !== 0x52494646 || tag(riff, 8) !== 0x57415645)
      throw audioError('invalid WAV header');
    const end = riff.getUint32(4, true) + 8;
    if (end !== blob.size) throw audioError('incomplete WAV container');
    let format = false,
      data = null,
      offset = 12,
      chunks = 0;
    while (offset < end) {
      if (offset + 8 > end || ++chunks > 1024) throw audioError('invalid WAV chunks');
      const chunk = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
      const kind = tag(chunk, 0),
        size = chunk.getUint32(4, true),
        start = offset + 8;
      if (start + size > end) throw audioError('incomplete WAV audio');
      if (kind === 0x666d7420) {
        if (format || size < 16) throw audioError('invalid PCM format');
        const fmt = new DataView(await blob.slice(start, start + 16).arrayBuffer());
        if (
          fmt.getUint16(0, true) !== 1 ||
          fmt.getUint16(2, true) !== 1 ||
          fmt.getUint32(4, true) !== 16000 ||
          fmt.getUint32(8, true) !== 32000 ||
          fmt.getUint16(12, true) !== 2 ||
          fmt.getUint16(14, true) !== 16
        ) {
          throw audioError('expected mono 16-bit PCM at 16 kHz');
        }
        format = true;
      } else if (kind === 0x64617461) {
        if (data || !size || size % 2) throw audioError('incomplete PCM sample');
        data = { start, bytes: size, samples: size / 2 };
      }
      offset = start + size + (size % 2);
      if (offset > end) throw audioError('incomplete WAV padding');
    }
    if (!format || !data) throw audioError('missing PCM format or audio');
    return data;
  }
  function wav(frames) {
    const bytes = pcmBytes(frames);
    const header = new ArrayBuffer(44),
      view = new DataView(header);
    const text = (at, value) =>
      [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, bytes + 36, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, bytes, true);
    return new Blob([header, ...frames], { type: 'audio/wav' });
  }
  function assemble(packets, options = {}) {
    const groups = new Map(),
      complete = new Map();
    for (const packet of packets) {
      if (!groups.has(packet.sequence)) groups.set(packet.sequence, []);
      groups.get(packet.sequence).push(packet);
    }
    let incomplete = 0;
    const transportFrames = {};
    for (const sequence of [...groups.keys()].sort((a, b) => a - b)) {
      const unique = new Map(groups.get(sequence).map((p) => [p.chunk, p]));
      const parts = [...unique.values()].sort((a, b) => a.chunk - b.chunk);
      const total = parts[0]?.total || 0;
      if (
        !total ||
        parts.length !== total ||
        parts.some((p, i) => p.chunk !== i || p.total !== total || p.transport !== parts[0].transport) ||
        parts.reduce((n, p) => n + p.payload.byteLength, 0) !== PCM_BYTES_PER_FRAME
      ) {
        incomplete++;
        continue;
      }
      const frame = new Uint8Array(PCM_BYTES_PER_FRAME);
      let offset = 0;
      for (const p of parts) {
        frame.set(p.payload, offset);
        offset += p.payload.byteLength;
      }
      complete.set(sequence, frame);
      const transport = parts[0].transport;
      if (transport === 'pcm16' || transport === 'adpcm')
        transportFrames[transport] = (transportFrames[transport] || 0) + 1;
    }
    const keys = [...groups.keys()].sort((a, b) => a - b);
    const firstSequence = keys.length ? keys[0] : -1,
      lastSequence = keys.length ? keys[keys.length - 1] : -1;
    const start = Number.isInteger(options.startSequence) ? options.startSequence : firstSequence;
    const end = Number.isInteger(options.endSequence) ? options.endSequence : lastSequence;
    const frames = [];
    let missing = 0;
    if (options.preserveTimeline && start >= 0 && end >= start) {
      for (let sequence = start; sequence <= end; sequence++) {
        const frame = complete.get(sequence);
        if (frame) frames.push(frame);
        else {
          frames.push(ZERO_FRAME);
          if (!groups.has(sequence)) missing++;
        }
      }
    } else frames.push(...[...complete.keys()].sort((a, b) => a - b).map((k) => complete.get(k)));
    return {
      frames,
      incomplete,
      missing,
      completeFrames: complete.size,
      ...(Object.keys(transportFrames).length ? { transportFrames } : {}),
      completeSequences: [...complete.keys()],
      packets: packets.length,
      frameGroups: groups.size,
      firstSequence,
      lastSequence,
    };
  }

  class AudioStore {
    constructor(options = {}) {
      this.idb = options.indexedDB || root.indexedDB;
      this.keys = options.IDBKeyRange || root.IDBKeyRange;
      this.name = options.name || 'dk-pendant-recordings';
      this.onError = options.onError || (() => {});
      this.buffer = [];
      this.timer = null;
      this.writing = Promise.resolve();
      this.failed = null;
      this.dbPromise = null;
      this.bufferedCount = 0;
      this.recoveryFailures = new Map();
      this.timeline = options.timeline || null;
      this.metadata = options.metadata || (() => ({}));
      this.rolling = Boolean(options.rolling);
      this.onWindowReady = options.onWindowReady || (() => {});
      this.onClosed = options.onClosed || (() => {});
      this.rollingIndex = new Map();
      this.rollingPending = new Set();
      this.rollingWork = Promise.resolve();
      this.closing = new Map();
      this.closed = new Set();
    }
    async open() {
      if (this.dbPromise) return this.dbPromise;
      let failed = false;
      this.dbPromise = new Promise((resolve, reject) => {
        const fail = (error) => {
          failed = true;
          reject(error);
        };
        const req = this.idb.open(this.name, 3);
        req.onupgradeneeded = () => {
          const db = req.result,
            tx = req.transaction;
          if (!db.objectStoreNames.contains('recordings')) {
            db.createObjectStore('recordings', { keyPath: 'id' }).createIndex(
              'createdAt',
              'createdAt',
            );
          }
          if (!db.objectStoreNames.contains('packets')) {
            const packets = db.createObjectStore('packets', {
              keyPath: ['recordingId', 'sequence', 'chunk'],
            });
            packets.createIndex('recording', 'recordingId');
            packets.createIndex('segment', ['recordingId', 'segmentIndex']);
          }
          if (!db.objectStoreNames.contains('segments')) {
            db.createObjectStore('segments', { keyPath: ['recordingId', 'index'] }).createIndex(
              'recording',
              'recordingId',
            );
          }
          if (!db.objectStoreNames.contains('jobs')) {
            const jobs = db.createObjectStore('jobs', { keyPath: 'id', autoIncrement: true });
            jobs.createIndex('recording', 'recordingId');
            jobs.createIndex('dedupe', 'dedupe', { unique: true });
            jobs.createIndex('state', 'state');
          } else if (tx) {
            const jobs = tx.objectStore('jobs');
            if (!jobs.indexNames.contains('state')) jobs.createIndex('state', 'state');
          }
        };
        req.onblocked = () =>
          fail(
            new Error(
              'Storage upgrade blocked. Close other Synap tabs, then tap Retry. Your recordings are kept.',
            ),
          );
        req.onerror = () => fail(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (failed) {
            db.close();
            return;
          }
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
          };
          resolve(db);
        };
      }).catch((error) => {
        this.dbPromise = null;
        throw error;
      });
      return this.dbPromise;
    }
    async atomic(names, action) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(names, 'readwrite', { durability: 'strict' });
        } catch (e) {
          if (e.name !== 'TypeError') {
            reject(e);
            return;
          }
          tx = db.transaction(names, 'readwrite');
        }
        let result, failure;
        tx.oncomplete = () => resolve(result);
        // Request errors bubble before tx.error is populated. Keep the cause,
        // and wait for rollback to finish before allowing a recovery attempt.
        tx.onerror = (event) => {
          failure ||= event.target?.error;
        };
        tx.onabort = () => reject(failure || tx.error || new Error('Storage transaction aborted'));
        try {
          action(
            Object.fromEntries(names.map((n) => [n, tx.objectStore(n)])),
            (v) => {
              result = v;
            },
            tx,
          );
        } catch (e) {
          failure = e;
          tx.abort();
        }
      });
    }
    async get(store, key) {
      const db = await this.open();
      return requestValue(db.transaction(store).objectStore(store).get(key));
    }
    async all(store, index, key) {
      const db = await this.open();
      let source = db.transaction(store).objectStore(store);
      if (index) source = source.index(index);
      return requestValue(source.getAll(key));
    }
    async verifyWritable() {
      const id = 'storage-check:' + root.crypto.randomUUID();
      // These rows are added and removed in one transaction: they are never
      // visible to readers and do not change any saved recording or job.
      await this.atomic(['recordings', 'packets', 'segments', 'jobs'], (s) => {
        s.recordings.add({ id });
        s.recordings.delete(id);
        s.packets.add({ recordingId: id, sequence: 0, chunk: 0, payload: new Uint8Array(1) });
        s.packets.delete([id, 0, 0]);
        s.segments.add({ recordingId: id, index: 0, pcmBlob: new Blob([new Uint8Array(1)]) });
        s.segments.delete([id, 0]);
        s.jobs.add({ id, recordingId: id, dedupe: id });
        s.jobs.delete(id);
      });
    }
    async begin(name, association = null) {
      if (this.failed) throw this.failed;
      const id = root.crypto.randomUUID();
      await this.atomic(['recordings'], (s) =>
        s.recordings.add({
          ...this.metadata(),
          id,
          name,
          createdAt: new Date().toISOString(),
          journal: true,
          status: 'recording',
          sampleRate: 16000,
          deviceId: association?.deviceId || null,
          deviceAssociationId: association?.associationId || null,
          pwaInstallationId: association?.installationId || null,
          notes: '',
          transcript: '',
          summary: '',
          durationMs: 0,
          sizeBytes: 0,
        }),
      );
      return id;
    }
    append(recordingId, packet) {
      if (this.failed) throw this.failed;
      if (this.closed.has(recordingId)) throw new Error('Recording is already closing or saved.');
      if (this.bufferedCount >= MAX_BUFFER_PACKETS)
        throw new Error(
          'Browser storage cannot keep up with BLE; stopping to preserve buffered audio.',
        );
      const sequence = this.timeline
        ? this.timeline.relativeSequence(recordingId, packet.sequence)
        : packet.sequence;
      // An old notification before this journal's origin cannot replace frame 0.
      if (sequence < 0) return;
      this.buffer.push({
        recordingId,
        sequence,
        chunk: packet.chunk,
        total: packet.total,
        segmentIndex: Math.floor(sequence / SEGMENT_FRAMES),
        payload: packet.payload.slice(),
        ...(packet.transport ? { transport: packet.transport } : {}),
      });
      this.bufferedCount++;
      if (!this.timer)
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush().catch(this.onError);
        }, 100);
      if (this.rolling) {
        const index = Math.floor(sequence / SEGMENT_FRAMES),
          previous = this.rollingIndex.get(recordingId);
        if (Number.isInteger(previous) && index > previous) this.sealWindow(recordingId, previous);
        if (Number.isInteger(previous) && index < previous && packet.chunk === packet.total - 1)
          this.sealWindow(recordingId, index);
        this.rollingIndex.set(recordingId, Math.max(previous ?? index, index));
      }
    }

    beginTransportEpoch(recordingId, gapFrames = 0) {
      return this.timeline?.beginTransportEpoch(recordingId, gapFrames) || false;
    }
    timelineOffsetMs(recordingId) {
      return this.timeline?.timelineOffsetMs(recordingId) || 0;
    }
    flushWindows() {
      return this.rollingWork;
    }
    sealWindow(recordingId, index) {
      const key = recordingId + ':' + index;
      if (this.rollingPending.has(key)) return;
      this.rollingPending.add(key);
      this.rollingWork = this.rollingWork
        .then(async () => {
          await this.flush();
          const meta = await this.get('segments', [recordingId, index]);
          if (meta?.pcmBlob) return;
          const packets = await this.all('packets', 'segment', [recordingId, index]);
          const start = index * SEGMENT_FRAMES;
          const data = assemble(packets, {
            preserveTimeline: true,
            startSequence: start,
            endSequence: start + SEGMENT_FRAMES - 1,
          });
          if (data.completeFrames !== SEGMENT_FRAMES || data.missing || data.incomplete) return;
          if ((await this.compactSegment(recordingId, index, data)) === false) return;
          try {
            this.onWindowReady({
              recordingId,
              segmentIndex: index,
              startMs: index * 30000,
              endMs: (index + 1) * 30000,
            });
          } catch (_) {
            /* A display/queue callback cannot undo durable PCM. */
          }
        })
        .catch((error) => {
          try {
            this.onError(error);
          } catch (_) {}
        })
        .finally(() => this.rollingPending.delete(key));
    }
    async flush() {
      clearTimeout(this.timer);
      this.timer = null;
      if (this.failed) throw this.failed;
      const batch = this.buffer.splice(0);
      this.writing = this.writing.then(
        async () => {
          if (!batch.length) return;
          try {
            await this.atomic(['packets', 'segments'], (s) => {
              const segments = new Map();
              for (const p of batch) {
                s.packets.put(p);
                segments.set(p.recordingId + ':' + p.segmentIndex, p);
              }
              for (const p of segments.values()) {
                const req = s.segments.get([p.recordingId, p.segmentIndex]);
                req.onsuccess = () => {
                  if (!req.result)
                    s.segments.put({
                      recordingId: p.recordingId,
                      index: p.segmentIndex,
                      closed: false,
                    });
                };
              }
            });
            this.bufferedCount -= batch.length;
          } catch (e) {
            this.buffer.unshift(...batch);
            this.failed = e;
            throw e;
          }
        },
        (e) => {
          this.buffer.unshift(...batch);
          throw e;
        },
      );
      return this.writing;
    }
    async retryFlush() {
      this.failed = null;
      this.writing = Promise.resolve();
      return this.flush();
    }
    async segment(recordingId, index) {
      const meta = await this.get('segments', [recordingId, index]);
      if (meta?.legacy)
        return {
          blob: (await this.get('recordings', recordingId))?.blob,
          frames: [],
          incomplete: 0,
          missing: 0,
          packets: 0,
          completeFrames: meta.frameCount || 0,
        };
      if (meta?.pcmBlob) {
        const pcm = new Uint8Array(await meta.pcmBlob.arrayBuffer());
        return {
          blob: wav([pcm]),
          frames: [],
          incomplete: meta.incomplete || 0,
          missing: meta.missing || 0,
          packets: meta.packets || 0,
          completeFrames: meta.frameCount || 0,
          ...(meta.transportFrames ? { transportFrames: meta.transportFrames } : {}),
          timelineFrames:
            meta.timelineFrameCount || Math.floor(pcm.byteLength / PCM_BYTES_PER_FRAME),
        };
      }
      return assemble(await this.all('packets', 'segment', [recordingId, index]));
    }
    async enqueueLegacy(recordingId, { preserveTranscript = false } = {}) {
      return this.atomic(['recordings', 'segments', 'jobs'], (s) => {
        const req = s.recordings.get(recordingId);
        req.onsuccess = () => {
          const r = req.result;
          if (!r || r.journal || r.queuedLegacy || !r.blob) return;
          s.recordings.put({ ...r, queuedLegacy: true });
          const transcribed =
            preserveTranscript &&
            r.transcriptComplete !== false &&
            typeof r.transcript === 'string' &&
            (r.transcript.trim() || r.transcriptComplete === true);
          s.segments.put({
            recordingId,
            index: 0,
            closed: true,
            legacy: true,
            ...(transcribed ? { transcript: r.transcript } : {}),
            frameCount: Math.max(1, Math.ceil((r.durationMs || 50) / 50)),
          });
          for (const kind of ['transcribe', 'summarize', 'consolidate'])
            enqueueJob(s.jobs, {
              recordingId,
              segmentIndex: kind === 'consolidate' ? -1 : 0,
              kind,
              dedupe: recordingId + ':legacy:' + kind,
              state: transcribed && kind === 'transcribe' ? 'done' : 'pending',
              attempts: 0,
              nextAt: 0,
            });
        };
      });
    }
    async enqueueCloudMonitor(recordingId) {
      return this.atomic(['recordings', 'jobs'], (s) => {
        const record = s.recordings.get(recordingId);
        record.onsuccess = () => {
          if (!record.result) return;
          const dedupe = recordingId + ':cloud-monitor',
            get = s.jobs.index('dedupe').get(dedupe);
          get.onsuccess = () =>
            s.jobs.put({
              ...get.result,
              recordingId,
              kind: 'consolidate',
              segmentIndex: -1,
              dedupe,
              cloudOnly: true,
              state: 'pending',
              attempts: 0,
              nextAt: 0,
              lastError: '',
            });
        };
      });
    }
    async compactSegment(
      recordingId,
      index,
      data,
      { final = false, hasAudio = data.completeFrames > 0 } = {},
    ) {
      // Until Stop, missing frames may still arrive from pendant recovery.
      // A PCM snapshot must not permanently replace those recoverable holes.
      if (!final && (data.missing || data.incomplete)) return false;
      // Validate before the transaction can delete the raw packet evidence.
      pcmBytes(data.frames, PCM_BYTES_PER_FRAME);
      const pcmBlob = new Blob(data.frames, { type: 'application/octet-stream' });
      const consumed = new Set(data.completeSequences || []);
      await this.atomic(['segments', 'packets', 'jobs'], (s) => {
        const req = s.segments.get([recordingId, index]);
        req.onsuccess = () => {
          const current = req.result || { recordingId, index };
          s.segments.put({
            ...current,
            closed: true,
            compacted: true,
            pcmBlob,
            frameCount: data.completeFrames,
            ...(data.transportFrames ? { transportFrames: data.transportFrames } : {}),
            timelineFrameCount: data.frames.length,
            incomplete: data.incomplete,
            missing: data.missing,
            packets: data.packets,
            firstSequence: data.firstSequence,
            lastSequence: data.lastSequence,
          });
        };
        const cursor = s.packets.index('segment').openCursor(this.keys.only([recordingId, index]));
        cursor.onsuccess = () => {
          if (cursor.result) {
            // Keep incomplete frames and packets that arrived after the
            // snapshot. They are not represented in the compacted PCM.
            if (consumed.has(cursor.result.value.sequence)) cursor.result.delete();
            cursor.result.continue();
          }
        };
        if (hasAudio && data.frames.length)
          for (const kind of ['transcribe', 'summarize']) {
            enqueueJob(s.jobs, {
              recordingId,
              segmentIndex: index,
              kind,
              dedupe: recordingId + ':' + index + ':' + kind,
              state: 'pending',
              attempts: 0,
              nextAt: 0,
            });
          }
      });
      return true;
    }
    async close(recordingId, reason = 'normal') {
      if (this.closing.has(recordingId)) return this.closing.get(recordingId);
      this.closed.add(recordingId);
      const work = (async () => {
        await this.flushWindows();
        const saved = await this.sealRecording(recordingId, reason);
        this.timeline?.forgetSequence(recordingId);
        this.rollingIndex.delete(recordingId);
        try {
          this.onClosed(saved);
        } catch (_) {}
        return saved;
      })().finally(() => this.closing.delete(recordingId));
      this.closing.set(recordingId, work);
      return work;
    }
    async sealRecording(recordingId, reason) {
      await this.flush();
      const record = await this.get('recordings', recordingId);
      if (!record || !record.journal) return;
      const segments = (await this.all('segments', 'recording', recordingId)).sort(
        (a, b) => a.index - b.index,
      );
      const byIndex = new Map(segments.map((segment) => [segment.index, segment])),
        raw = new Map();
      let lastSequence = -1,
        packets = 0,
        incomplete = 0,
        capturedFrames = 0;
      for (const segment of segments) {
        if (segment.pcmBlob) {
          lastSequence = Math.max(lastSequence, segment.lastSequence ?? -1);
          packets += segment.packets || 0;
          incomplete += segment.incomplete || 0;
          capturedFrames += segment.frameCount || 0;
          continue;
        }
        const list = await this.all('packets', 'segment', [recordingId, segment.index]);
        raw.set(segment.index, list);
        const scan = assemble(list);
        lastSequence = Math.max(lastSequence, scan.lastSequence);
        packets += scan.packets;
        incomplete += scan.incomplete;
        capturedFrames += scan.completeFrames;
      }
      const transportFrames = {};
      const addTransport = counts => {
        for (const kind of ['pcm16', 'adpcm'])
          if (counts?.[kind]) transportFrames[kind] = (transportFrames[kind] || 0) + counts[kind];
      };
      let complete = 0,
        missing = 0,
        timelineFrames = 0;
      if (lastSequence >= 0) {
        const lastIndex = Math.floor(lastSequence / SEGMENT_FRAMES);
        for (let index = 0; index <= lastIndex; index++) {
          const segment = byIndex.get(index);
          if (segment?.pcmBlob) {
            addTransport(segment.transportFrames);
            complete += segment.frameCount || 0;
            missing += segment.missing || 0;
            timelineFrames += segment.timelineFrameCount || 0;
            continue;
          }
          const start = index * SEGMENT_FRAMES,
            end = Math.min(lastSequence, start + SEGMENT_FRAMES - 1);
          const data = assemble(raw.get(index) || [], {
            preserveTimeline: true,
            startSequence: start,
            endSequence: end,
          });
          addTransport(data.transportFrames);
          complete += data.completeFrames;
          missing += data.missing;
          timelineFrames += data.frames.length;
          // Entirely missing windows still need an upload job so finalization
          // sees every timeline segment. Purely empty captures stay unqueued.
          await this.compactSegment(recordingId, index, data, {
            final: true,
            hasAudio: capturedFrames > 0,
          });
        }
      }
      await this.atomic(['recordings', 'jobs'], (s) => {
        const req = s.recordings.get(recordingId);
        req.onsuccess = () => {
          if (!req.result) return;
          const previous = req.result;
          s.recordings.put({
            ...previous,
            status: complete ? 'saved' : 'empty',
            stopReason: reason,
            durationMs: lastSequence >= 0 ? (lastSequence + 1) * 50 : 0,
            sizeBytes: timelineFrames ? 44 + timelineFrames * PCM_BYTES_PER_FRAME : 0,
            stats: {
              completeFrames: complete,
              ...(Object.keys(transportFrames).length ? { transportFrames } : {}),
              incompleteFrames: incomplete,
              packetsReceived: packets,
              missingFrames: missing,
            },
            sealed: true,
            compacted: true,
          });
          if (!previous.sealed && complete)
            enqueueJob(s.jobs, {
              recordingId,
              kind: 'consolidate',
              segmentIndex: -1,
              dedupe: recordingId + ':consolidate',
              state: 'pending',
              attempts: 0,
              nextAt: 0,
            });
        };
      });
      return this.get('recordings', recordingId);
    }
    async recover(recordingIds) {
      const selected = recordingIds ? new Set(recordingIds) : null;
      const records = (await this.all('recordings'))
        .filter((r) => r.journal && !r.sealed && (!selected || selected.has(r.id)))
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      if (!selected) this.recoveryFailures.clear();
      const resolved = new Set(selected || []);
      let recovered = 0;
      for (const r of records) {
        try {
          await this.close(r.id, 'recovered-after-interruption');
          resolved.add(r.id);
          recovered++;
        } catch (error) {
          this.recoveryFailures.set(r.id, error);
          resolved.delete(r.id);
        }
      }
      // A page/process crash can leave a durable job marked running even though no
      // worker survives. A later retry only touches the failed recordings, never
      // an active capture or jobs belonging to a live processor.
      for (const job of (await this.all('jobs')).filter(
        (j) =>
          j.state === 'running' &&
          (!selected || selected.has(j.recordingId)) &&
          (!this.recoveryFailures.has(j.recordingId) || resolved.has(j.recordingId)),
      )) {
        await this.patchJob(job.id, {
          state: 'pending',
          nextAt: 0,
          lastError: 'Recovered after interruption',
        });
      }
      await this.verifyWritable();
      for (const id of resolved) this.recoveryFailures.delete(id);
      return recovered;
    }
    async blob(record) {
      if (record.blob) return record.blob;
      const segments = (await this.all('segments', 'recording', record.id)).sort(
        (a, b) => a.index - b.index,
      );
      const pcm = [];
      for (const segment of segments) {
        if (segment.pcmBlob) {
          pcm.push(new Uint8Array(await segment.pcmBlob.arrayBuffer()));
          continue;
        }
        const packets = await this.all('packets', 'segment', [record.id, segment.index]);
        const end = segment.lastSequence ?? assemble(packets).lastSequence;
        const data = assemble(packets, {
          preserveTimeline: true,
          startSequence: segment.index * SEGMENT_FRAMES,
          endSequence: end,
        });
        pcm.push(...data.frames);
      }
      if (!pcm.length)
        throw new Error(
          'No complete audio frames are available. Raw partial chunks remain stored.',
        );
      return wav(pcm);
    }
    async remove(id) {
      this.closed.add(id);
      await this.flushWindows();
      await this.closing.get(id);
      await this.flush();
      await this.atomic(['recordings', 'packets', 'segments', 'jobs'], (s) => {
        s.recordings.delete(id);
        for (const name of ['packets', 'segments', 'jobs']) {
          const cursor = s[name].index('recording').openCursor(this.keys.only(id));
          cursor.onsuccess = () => {
            if (cursor.result) {
              cursor.result.delete();
              cursor.result.continue();
            }
          };
        }
      });
      this.timeline?.forgetSequence(id);
      this.rollingIndex.delete(id);
    }
    async clear() {
      await this.atomic(['recordings', 'packets', 'segments', 'jobs'], (s) =>
        Object.values(s).forEach((store) => store.clear()),
      );
    }
    async head() {
      const jobs = await this.all('jobs');
      return jobs.sort((a, b) => a.id - b.id).find((j) => j.state !== 'done') || null;
    }
    async nextRunnable(now = Date.now(), excludedRecordings = new Set(), allowedRecordings = null) {
      const jobs = (await this.all('jobs'))
          .filter((job) => !allowedRecordings || allowedRecordings.has(job.recordingId))
          .sort((a, b) => a.id - b.id),
        blocked = new Set(
          [...this.recoveryFailures.keys()].filter(
            (id) => !allowedRecordings || allowedRecordings.has(id),
          ),
        ),
        deferred = new Set();
      let wakeAt = Infinity;
      for (const job of jobs) {
        if (job.state === 'done') continue;
        if (job.state === 'failed') {
          blocked.add(job.recordingId);
          continue;
        }
        if (
          blocked.has(job.recordingId) ||
          deferred.has(job.recordingId) ||
          excludedRecordings.has(job.recordingId)
        )
          continue;
        if (job.state === 'running') {
          deferred.add(job.recordingId);
          continue;
        }
        if ((job.nextAt || 0) > now) {
          wakeAt = Math.min(wakeAt, job.nextAt);
          deferred.add(job.recordingId);
          continue;
        }
        return { job, wakeAt: Number.isFinite(wakeAt) ? wakeAt : 0, blockedCount: blocked.size };
      }
      return {
        job: null,
        wakeAt: Number.isFinite(wakeAt) ? wakeAt : 0,
        blockedCount: blocked.size,
      };
    }
    async patchJob(id, fields) {
      return this.atomic(['jobs'], (s, result) => {
        const req = s.jobs.get(id);
        req.onsuccess = () => {
          if (!req.result) {
            result(false);
            return;
          }
          s.jobs.put({ ...req.result, ...fields });
          result(true);
        };
      });
    }
    async finishJob(job, output) {
      return this.atomic(['jobs', 'segments', 'recordings'], (s, result) => {
        const req = s.jobs.get(job.id);
        req.onsuccess = () => {
          if (!req.result) return;
          const store = job.kind === 'consolidate' ? s.recordings : s.segments;
          const item = store.get(
            job.kind === 'consolidate' ? job.recordingId : [job.recordingId, job.segmentIndex],
          );
          item.onsuccess = () => {
            if (!item.result) return;
            const saved = { ...item.result, ...output };
            if (job.kind === 'consolidate')
              saved.processedAt = output.processedAt || new Date().toISOString();
            store.put(saved);
            s.jobs.put({ ...req.result, state: 'done', lastError: '', finishedAt: Date.now() });
            result(saved); // atomic() resolves only after the transaction commits.
          };
        };
      });
    }
  }

  root.DKAudioStore = AudioStore;
  root.DKAudioCodec = { assemble, wav, validateWav, SEGMENT_FRAMES, PCM_BYTES_PER_FRAME };
})(globalThis);
