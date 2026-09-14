/* Import source WAVs without decoding, processing or changing their sample bytes. */
(function (root) {
  'use strict';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const account = () => String(root.SynapAuth?.session?.()?.profile?.uid || '') || null;
  const bad = () =>
    new Error('This WAV has invalid synap metadata. Keep the original file for recovery.');

  async function inspect(blob) {
    const audio = await root.DKAudioCodec.validateWav(blob);
    let offset = 12,
      native = null;
    while (offset < blob.size) {
      const header = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
      const size = header.getUint32(4, true),
        start = offset + 8;
      if (header.getUint32(0, false) === 0x73796170) {
        if (native || size > 65536) throw bad();
        let value;
        try {
          value = JSON.parse(await blob.slice(start, start + size).text());
        } catch (_) {
          throw bad();
        }
        const counts = ['completeFrames', 'missingFrames', 'pcmFrames', 'adpcmFrames'];
        if (
          !value ||
          value.schema !== 1 ||
          value.source !== 'synap-native-ios' ||
          !uuid.test(value.id) ||
          typeof value.name !== 'string' ||
          value.name.length > 200 ||
          typeof value.createdAt !== 'string' ||
          value.createdAt.length > 64 ||
          !Number.isFinite(Date.parse(value.createdAt)) ||
          !/^SYNAP-[0-9a-f]{12}$/i.test(value.deviceId) ||
          !counts.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
          audio.samples % 800 ||
          value.completeFrames + value.missingFrames !== audio.samples / 800 ||
          value.pcmFrames + value.adpcmFrames !== value.completeFrames ||
          !Array.isArray(value.moments) ||
          value.moments.length > 1000 ||
          !value.moments.every(
            (time) => Number.isFinite(time) && time >= 0 && time <= audio.samples / 16000,
          )
        )
          throw bad();
        // Only explicitly supported provenance fields cross this boundary. Never ownership/tokens.
        native = Object.fromEntries(
          ['id', 'name', 'createdAt', 'deviceId', ...counts, 'moments'].map((key) => [
            key,
            value[key],
          ]),
        );
      }
      offset = start + size + (size % 2);
    }
    return { audio, native };
  }

  async function save(file, store, check = () => {}) {
    const owner = account();
    const guard = () => {
      check();
      if (account() !== owner)
        throw new Error('The signed-in account changed. Choose the file again.');
    };
    guard();
    const { audio, native } = await inspect(file);
    guard();
    const id = root.crypto.randomUUID(),
      now = new Date().toISOString();
    const createdAt = native ? new Date(native.createdAt).toISOString() : now;
    const recording = {
      id,
      ownerUid: owner,
      name:
        (native?.name || String(file.name || 'Imported audio').replace(/\.wav$/i, ''))
          .trim()
          .slice(0, 200) || 'Imported audio',
      createdAt,
      importedAt: now,
      captureSource: native ? 'native-ios' : 'imported-wav',
      importedAudio: true,
      nativeRecordingId: native?.id || null,
      nativeDeviceId: native?.deviceId || null,
      // A file is provenance, not evidence of a signed-in device association.
      deviceId: null,
      deviceAssociationId: null,
      pwaInstallationId: null,
      journal: true,
      sealed: true,
      compacted: true,
      status: 'saved',
      sampleRate: 16000,
      durationMs: audio.samples / 16,
      sizeBytes: file.size,
      blob: file,
      notes: '',
      transcript: '',
      summary: '',
      uploadAudioProcessing: 'none',
      rememberMarkers: (native?.moments || []).map((time) => ({
        id: root.crypto.randomUUID(),
        offsetMs: Math.round(time * 1000),
        source: 'pwa',
        createdAt: new Date(Date.parse(createdAt) + time * 1000).toISOString(),
      })),
      ...(native
        ? {
            stats: {
              completeFrames: native.completeFrames,
              missingFrames: native.missingFrames,
              transportFrames: { pcm16: native.pcmFrames, adpcm: native.adpcmFrames },
            },
          }
        : {}),
    };
    // Blob slices keep memory bounded. Upload windows fit the existing 30-second pipeline.
    // Keep the original WAV, including its metadata, for byte-identical playback/export.
    const bytesPerWindow = root.DKAudioCodec.SEGMENT_FRAMES * 1600;
    await store.atomic(['recordings', 'segments'], (stores) => {
      guard();
      stores.recordings.add(recording); // Each import is a new take; a file ID cannot replace data.
      for (let offset = 0, index = 0; offset < audio.bytes; offset += bytesPerWindow, index++) {
        const bytes = Math.min(bytesPerWindow, audio.bytes - offset);
        stores.segments.add({
          recordingId: id,
          index,
          closed: true,
          pcmBlob: file.slice(audio.start + offset, audio.start + offset + bytes),
          // Processing counts frames in the exported PCM, including explicit gap silence.
          // Actual received/missing transport counts remain on recording.stats.
          frameCount: Math.ceil(bytes / 1600),
          sampleCount: bytes / 2,
          timelineFrameCount: bytes / 1600,
        });
      }
    });
    return recording;
  }

  async function enqueue(store, id) {
    return store.atomic(['recordings', 'segments', 'jobs'], (stores) => {
      const request = stores.recordings.get(id);
      request.onsuccess = () => {
        const recording = request.result;
        if (!recording?.importedAudio || recording.queuedImport) return;
        const segments = stores.segments.index('recording').getAll(id);
        segments.onsuccess = () => {
          if (!segments.result.length) return;
          stores.recordings.put({ ...recording, queuedImport: true });
          for (const segment of segments.result) {
            for (const kind of ['transcribe', 'summarize'])
              stores.jobs.add({
                recordingId: id,
                segmentIndex: segment.index,
                kind,
                dedupe: id + ':' + segment.index + ':' + kind,
                state: 'pending',
                attempts: 0,
                nextAt: 0,
              });
          }
          stores.jobs.add({
            recordingId: id,
            segmentIndex: -1,
            kind: 'consolidate',
            dedupe: id + ':consolidate',
            state: 'pending',
            attempts: 0,
            nextAt: 0,
          });
        };
      };
    });
  }
  root.SynapAudioImport = Object.freeze({ inspect, save, enqueue });
})(globalThis);
