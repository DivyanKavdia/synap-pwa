/* Synap Sep-06 enhancement pack.
 *
 * Adds rolling one-minute capture segments without changing the BLE protocol,
 * starts processing a completed minute while capture continues, keeps legacy
 * 30-second recordings readable, hides memory-bearing UI immediately on
 * sign-out, and makes completed transcripts visible by default.
 */
(function (root) {
  'use strict';

  const ONE_MINUTE_FRAMES = 1200; // 60 s / 50 ms protocol frame.
  const LEGACY_SEGMENT_FRAMES = 600;
  const PCM_BYTES_PER_FRAME = 1600;
  const PROCESSOR_REGISTRY = new Set();
  const AUTH_POLL_MS = 50;
  const INSTALL_POLL_MS = 40;

  function currentUid() {
    try {
      const session = root.SynapAuth && root.SynapAuth.session && root.SynapAuth.session();
      return String(session && session.profile && session.profile.uid || '');
    } catch (_) {
      return '';
    }
  }

  function ownerForNewRecording() {
    return currentUid() || null;
  }

  function segmentFrames(record) {
    return Number(record && record.segmentFrames) === ONE_MINUTE_FRAMES
      ? ONE_MINUTE_FRAMES
      : LEGACY_SEGMENT_FRAMES;
  }

  function installAudioPatch() {
    const Store = root.DKAudioStore;
    const Processor = root.DKFIFOProcessor;
    const codec = root.DKAudioCodec;
    if (!Store || !Processor || !codec || !codec.assemble || Store.prototype.__synapMinuteSegments) return false;

    const originalBegin = Store.prototype.begin;
    const originalAppend = Store.prototype.append;
    const originalResume = Processor.prototype.resume;

    Store.prototype.begin = async function (name, association) {
      const id = await originalBegin.call(this, name, association);
      this.__synapFramesByRecording = this.__synapFramesByRecording || new Map();
      this.__synapFramesByRecording.set(id, ONE_MINUTE_FRAMES);
      await this.atomic(['recordings'], (stores) => {
        const request = stores.recordings.get(id);
        request.onsuccess = () => {
          if (!request.result) return;
          stores.recordings.put(Object.assign({}, request.result, {
            segmentFrames: ONE_MINUTE_FRAMES,
            segmentSeconds: 60,
            ownerUid: ownerForNewRecording(),
            rollingProcessing: true
          }));
        };
      });
      return id;
    };

    function queueSeal(store, recordingId, index) {
      if (index < 0) return;
      store.__synapSealQueue = (store.__synapSealQueue || Promise.resolve()).then(async () => {
        await store.flush();
        const meta = await store.get('segments', [recordingId, index]);
        if (meta && meta.pcmBlob) return;
        const packets = await store.all('packets', 'segment', [recordingId, index]);
        if (!packets.length) return;
        const start = index * ONE_MINUTE_FRAMES;
        const end = start + ONE_MINUTE_FRAMES - 1;
        const data = codec.assemble(packets, {
          preserveTimeline: true,
          startSequence: start,
          endSequence: end
        });
        if (!data.completeFrames) return;
        await store.compactSegment(recordingId, index, data);
        root.dispatchEvent(new CustomEvent('synap-segment-ready', {
          detail: { recordingId: recordingId, segmentIndex: index, seconds: 60 }
        }));
      }).catch((error) => {
        try { store.onError(error); } catch (_) {}
      });
    }

    Store.prototype.append = function (recordingId, packet) {
      originalAppend.call(this, recordingId, packet);
      const buffer = this.buffer || [];
      const last = buffer[buffer.length - 1];
      if (!last || last.recordingId !== recordingId || last.sequence !== packet.sequence || last.chunk !== packet.chunk) return;

      const frames = this.__synapFramesByRecording && this.__synapFramesByRecording.get(recordingId);
      if (frames !== ONE_MINUTE_FRAMES) return; // legacy/recovered capture remains on its original geometry.

      const nextIndex = Math.floor(packet.sequence / ONE_MINUTE_FRAMES);
      last.segmentIndex = nextIndex;
      this.__synapActiveSegment = this.__synapActiveSegment || new Map();
      const previous = this.__synapActiveSegment.get(recordingId);
      if (Number.isInteger(previous) && nextIndex > previous) queueSeal(this, recordingId, previous);
      this.__synapActiveSegment.set(recordingId, nextIndex);
    };

    Store.prototype.close = async function (recordingId, reason) {
      await (this.__synapSealQueue || Promise.resolve());
      await this.flush();
      const record = await this.get('recordings', recordingId);
      if (!record || !record.journal) return;
      const framesPerSegment = segmentFrames(record);
      const segments = (await this.all('segments', 'recording', recordingId)).sort((a, b) => a.index - b.index);
      const byIndex = new Map(segments.map((segment) => [segment.index, segment]));
      const raw = new Map();
      let lastSequence = -1, packets = 0, incomplete = 0;

      for (const segment of segments) {
        if (segment.pcmBlob) {
          lastSequence = Math.max(lastSequence, segment.lastSequence == null ? -1 : segment.lastSequence);
          packets += segment.packets || 0;
          incomplete += segment.incomplete || 0;
          continue;
        }
        const list = await this.all('packets', 'segment', [recordingId, segment.index]);
        raw.set(segment.index, list);
        const scan = codec.assemble(list);
        lastSequence = Math.max(lastSequence, scan.lastSequence);
        packets += scan.packets;
        incomplete += scan.incomplete;
      }

      let complete = 0, missing = 0, timelineFrames = 0;
      if (lastSequence >= 0) {
        const lastIndex = Math.floor(lastSequence / framesPerSegment);
        for (let index = 0; index <= lastIndex; index += 1) {
          const segment = byIndex.get(index);
          if (segment && segment.pcmBlob) {
            complete += segment.frameCount || 0;
            missing += segment.missing || 0;
            timelineFrames += segment.timelineFrameCount || 0;
            continue;
          }
          const start = index * framesPerSegment;
          const end = Math.min(lastSequence, start + framesPerSegment - 1);
          const data = codec.assemble(raw.get(index) || [], {
            preserveTimeline: true,
            startSequence: start,
            endSequence: end
          });
          complete += data.completeFrames;
          missing += data.missing;
          timelineFrames += data.frames.length;
          await this.compactSegment(recordingId, index, data);
        }
      }

      await this.atomic(['recordings', 'jobs'], (stores) => {
        const request = stores.recordings.get(recordingId);
        request.onsuccess = () => {
          if (!request.result) return;
          const previous = request.result;
          stores.recordings.put(Object.assign({}, previous, {
            status: complete ? 'saved' : 'empty',
            stopReason: reason || 'normal',
            durationMs: lastSequence >= 0 ? (lastSequence + 1) * 50 : 0,
            sizeBytes: timelineFrames ? 44 + timelineFrames * PCM_BYTES_PER_FRAME : 0,
            stats: {
              completeFrames: complete,
              incompleteFrames: incomplete,
              packetsReceived: packets,
              missingFrames: missing
            },
            sealed: true,
            compacted: true
          }));
          if (!previous.sealed && complete) {
            stores.jobs.add({
              recordingId: recordingId,
              kind: 'consolidate',
              segmentIndex: -1,
              dedupe: recordingId + ':consolidate',
              state: 'pending', attempts: 0, nextAt: 0
            });
          }
        };
      });
      if (this.__synapActiveSegment) this.__synapActiveSegment.delete(recordingId);
      return this.get('recordings', recordingId);
    };

    Store.prototype.blob = async function (record) {
      if (record.blob) return record.blob;
      const framesPerSegment = segmentFrames(record);
      const segments = (await this.all('segments', 'recording', record.id)).sort((a, b) => a.index - b.index);
      const pcm = [];
      for (const segment of segments) {
        if (segment.pcmBlob) {
          pcm.push(new Uint8Array(await segment.pcmBlob.arrayBuffer()));
          continue;
        }
        const packets = await this.all('packets', 'segment', [record.id, segment.index]);
        const end = segment.lastSequence == null ? codec.assemble(packets).lastSequence : segment.lastSequence;
        const data = codec.assemble(packets, {
          preserveTimeline: true,
          startSequence: segment.index * framesPerSegment,
          endSequence: end
        });
        pcm.push.apply(pcm, data.frames);
      }
      if (!pcm.length) throw new Error('No complete audio frames are available. Raw partial chunks remain stored.');
      return codec.wav(pcm);
    };

    // Original scheduling isolates recordings. Keep that property for dependent
    // jobs, but allow sealed transcribe/upload jobs from one recording to overlap.
    Store.prototype.nextRunnable = async function (now, excludedRecordings) {
      now = now == null ? Date.now() : now;
      excludedRecordings = excludedRecordings || new Set();
      const jobs = (await this.all('jobs')).sort((a, b) => a.id - b.id);
      const blocked = new Set(), deferred = new Set();
      let wakeAt = Infinity;
      for (const job of jobs) {
        if (job.state === 'done') continue;
        if (job.state === 'failed') { blocked.add(job.recordingId); continue; }
        if (blocked.has(job.recordingId) || deferred.has(job.recordingId)) continue;
        if (excludedRecordings.has(job.recordingId) && job.kind !== 'transcribe') continue;
        if (job.state === 'running') {
          if (job.kind !== 'transcribe') deferred.add(job.recordingId);
          continue;
        }
        if ((job.nextAt || 0) > now) {
          wakeAt = Math.min(wakeAt, job.nextAt);
          if (job.kind !== 'transcribe') deferred.add(job.recordingId);
          continue;
        }
        return { job: job, wakeAt: Number.isFinite(wakeAt) ? wakeAt : 0, blockedCount: blocked.size };
      }
      return { job: null, wakeAt: Number.isFinite(wakeAt) ? wakeAt : 0, blockedCount: blocked.size };
    };

    Processor.prototype.resume = function () {
      PROCESSOR_REGISTRY.add(this);
      return originalResume.apply(this, arguments);
    };
    root.addEventListener('synap-segment-ready', () => {
      PROCESSOR_REGISTRY.forEach((processor) => {
        try {
          if (!processor.paused && processor.canRun()) processor.run();
        } catch (_) {}
      });
    });

    Store.prototype.__synapMinuteSegments = true;
    return true;
  }

  function installPrivacyAndTranscriptUi() {
    if (!root.document || root.document.getElementById('synapAccountPrivacyStyle')) return;
    const style = root.document.createElement('style');
    style.id = 'synapAccountPrivacyStyle';
    style.textContent = [
      'body[data-synap-account-state="signed-out"] #today .day-brief,',
      'body[data-synap-account-state="signed-out"] #insights,',
      'body[data-synap-account-state="signed-out"] #library,',
      'body[data-synap-account-state="signed-out"] #processing{display:none!important}',
      '.synap-signed-out-note{margin:1rem 0;padding:.8rem 1rem;border:1px solid var(--border);border-radius:14px;background:var(--surface-2);font-size:.82rem;line-height:1.45}',
      '.transcript-preview[open]>summary{font-weight:700}'
    ].join('');
    root.document.head.appendChild(style);

    const note = root.document.createElement('p');
    note.id = 'synapSignedOutPrivacyNote';
    note.className = 'synap-signed-out-note';
    note.textContent = 'Sign in to view your recordings, transcripts and memories.';
    note.hidden = true;
    const capture = root.document.getElementById('capture');
    if (capture) capture.insertAdjacentElement('beforebegin', note);

    function makeTranscriptsVisible() {
      root.document.querySelectorAll('details.transcript-preview').forEach((details) => { details.open = true; });
      root.document.querySelectorAll('.recording-card details').forEach((details) => {
        const summary = details.querySelector(':scope > summary');
        if (summary && /^transcript$/i.test(summary.textContent.trim())) details.open = true;
      });
    }

    new MutationObserver(makeTranscriptsVisible).observe(root.document.body, { childList: true, subtree: true });
    makeTranscriptsVisible();

    function applySession(session) {
      const uid = String(session && session.profile && session.profile.uid || '');
      root.document.body.dataset.synapAccountState = uid ? 'signed-in' : 'signed-out';
      note.hidden = Boolean(uid);
      if (!uid) {
        PROCESSOR_REGISTRY.forEach((processor) => {
          try { processor.pause(); } catch (_) {}
        });
        const search = root.document.querySelector('.memory-results');
        if (search) search.replaceChildren();
      }
    }

    let attempts = 0;
    const timer = root.setInterval(() => {
      if (root.SynapAuth && typeof root.SynapAuth.onChange === 'function') {
        root.clearInterval(timer);
        root.SynapAuth.onChange(applySession);
      } else if (++attempts > 400) {
        root.clearInterval(timer);
        applySession(null);
      }
    }, AUTH_POLL_MS);
  }

  function boot() {
    installPrivacyAndTranscriptUi();
    if (installAudioPatch()) return;
    let attempts = 0;
    const timer = root.setInterval(() => {
      if (installAudioPatch() || ++attempts > 400) root.clearInterval(timer);
    }, INSTALL_POLL_MS);
  }

  if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  root.SynapEnhancementPack = {
    ONE_MINUTE_FRAMES: ONE_MINUTE_FRAMES,
    LEGACY_SEGMENT_FRAMES: LEGACY_SEGMENT_FRAMES,
    installAudioPatch: installAudioPatch
  };
})(globalThis);
