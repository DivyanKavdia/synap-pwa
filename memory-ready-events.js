/* Call emit only after a completed memory has been committed to local storage. */
(function (root) {
  'use strict';
  const seen = new Map();

  function signature(recording) {
    if (
      !recording ||
      (recording.processingState !== 'done' && recording.processingStage !== 'ready')
    )
      return '';
    return String(
      recording.processedAt || recording.processingUpdatedAt || recording.restoredAt || 'ready',
    );
  }

  function emit(recording) {
    const sig = signature(recording);
    const id = String(recording?.id || '');
    if (!id || !sig || seen.get(id) === sig) return false;
    seen.set(id, sig);
    if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(
        new root.CustomEvent('synap-memory-ready', {
          detail: {
            recordingId: id,
            processedAt: recording.processedAt || null,
            source: recording.restoredFromCloud ? 'cloud' : 'processing',
          },
        }),
      );
    }
    return true;
  }

  root.SynapMemoryReadyEvents = { emit, signature };
})(globalThis);
