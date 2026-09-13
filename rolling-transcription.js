/* Rolling transcription bridge.
 * Storage remains one logical recording for the complete meeting. The journal's
 * existing 30-second PCM segments are processing windows only.
 */
(function (root) {
  'use strict';
  const WINDOW_FRAMES = 600;
  let installAttempts = 0;
  function providerIsSynap() {
    try {
      const value = JSON.parse(root.localStorage?.getItem('synap-ai-provider-settings') || '{}');
      return String(value.provider || 'synap') === 'synap';
    } catch (_) {
      return true;
    }
  }
  function signedIn() {
    try {
      return Boolean(root.SynapAuth?.isSignedIn?.());
    } catch (_) {
      return false;
    }
  }
  function kickProcessor() {
    if (!providerIsSynap() || !signedIn()) return;
    const processor = root.SynapProcessingQueue;
    if (processor && typeof processor.resume === 'function') {
      try {
        const pending = processor.resume();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        return;
      } catch (_) {}
    }
  }
  function install() {
    const Store = root.DKAudioStore,
      codec = root.DKAudioCodec;
    if (!Store || !codec?.assemble) return false;
    if (Store.prototype.__synapRollingTranscription) return true;
    const originalBegin = Store.prototype.begin,
      originalAppend = Store.prototype.append,
      originalClose = Store.prototype.close;
    Store.prototype.begin = async function (name, association) {
      const id = await originalBegin.call(this, name, association);
      try {
        const session = root.SynapAuth?.session?.();
        const uid = String(session?.profile?.uid || '') || null;
        await this.atomic(['recordings'], (stores) => {
          const request = stores.recordings.get(id);
          request.onsuccess = () => {
            if (request.result)
              stores.recordings.put({
                ...request.result,
                ownerUid: uid,
                rollingTranscription: true,
                transcriptionWindowSeconds: 30,
              });
          };
        });
      } catch (_) {}
      return id;
    };
    function sealWindow(store, recordingId, index) {
      if (!Number.isInteger(index) || index < 0) return;
      const key = recordingId + ':' + index;
      store.__synapRollingPending = store.__synapRollingPending || new Set();
      if (store.__synapRollingPending.has(key)) return;
      store.__synapRollingPending.add(key);
      store.__synapRollingSeal = (store.__synapRollingSeal || Promise.resolve())
        .then(async () => {
          await store.flush();
          const meta = await store.get('segments', [recordingId, index]);
          if (meta?.pcmBlob) {
            kickProcessor();
            return;
          }
          const packets = await store.all('packets', 'segment', [recordingId, index]);
          if (!packets.length) return;
          const start = index * WINDOW_FRAMES,
            end = start + WINDOW_FRAMES - 1;
          const data = codec.assemble(packets, {
            preserveTimeline: true,
            startSequence: start,
            endSequence: end,
          });
          // Crossing a window boundary does not prove all earlier audio was
          // received. Keep its packets until recovery fills it or Stop seals it.
          if (data.completeFrames !== WINDOW_FRAMES || data.missing || data.incomplete) return;
          if (await store.compactSegment(recordingId, index, data) === false) return;
          root.dispatchEvent(
            new CustomEvent('synap-transcription-window-ready', {
              detail: {
                recordingId,
                segmentIndex: index,
                startMs: index * 30000,
                endMs: (index + 1) * 30000,
              },
            }),
          );
          kickProcessor();
        })
        .catch((error) => {
          try {
            store.onError(error);
          } catch (_) {}
        })
        .finally(() => store.__synapRollingPending.delete(key));
    }
    Store.prototype.append = function (recordingId, packet) {
      originalAppend.call(this, recordingId, packet);
      const index = Math.floor(packet.sequence / WINDOW_FRAMES);
      this.__synapRollingIndex = this.__synapRollingIndex || new Map();
      const previous = this.__synapRollingIndex.get(recordingId);
      if (Number.isInteger(previous) && index > previous) sealWindow(this, recordingId, previous);
      // Recovered packets may go backwards in time. They can finish an older
      // window without moving the live window cursor backwards.
      if (Number.isInteger(previous) && index < previous && packet.chunk === packet.total - 1) {
        sealWindow(this, recordingId, index);
      }
      this.__synapRollingIndex.set(recordingId, Math.max(previous ?? index, index));
    };
    Store.prototype.close = async function (recordingId, reason) {
      await (this.__synapRollingSeal || Promise.resolve());
      const saved = await originalClose.call(this, recordingId, reason);
      if (this.__synapRollingIndex) this.__synapRollingIndex.delete(recordingId);
      kickProcessor();
      return saved;
    };
    Store.prototype.__synapRollingTranscription = true;
    return true;
  }
  if (!install()) {
    const timer = root.setInterval(() => {
      if (install() || ++installAttempts > 400) root.clearInterval(timer);
    }, 40);
  }
})(globalThis);
