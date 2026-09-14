/* Explicit capture configuration. Merely loading this module never changes storage. */
(function (root) {
  'use strict';

  function kickProcessor() {
    try {
      const settings = JSON.parse(root.localStorage?.getItem('synap-ai-provider-settings') || '{}');
      if (String(settings.provider || 'synap') !== 'synap' || !root.SynapAuth?.isSignedIn?.())
        return;
      const pending = root.SynapProcessingQueue?.resume?.();
      pending?.catch?.(() => {});
    } catch (_) {}
  }

  function options({ transport = false } = {}) {
    return {
      timeline: transport ? new root.SynapRecordingTimeline() : null,
      rolling: true,
      metadata: () => ({
        ownerUid: String(root.SynapAuth?.session?.()?.profile?.uid || '') || null,
        rollingTranscription: true,
        transcriptionWindowSeconds: 30,
        uploadAudioProcessing: 'none',
      }),
      onWindowReady(detail) {
        root.dispatchEvent(new CustomEvent('synap-transcription-window-ready', { detail }));
        kickProcessor();
      },
      onClosed: kickProcessor,
    };
  }

  root.SynapRecordingJournal = Object.freeze({ options });
})(globalThis);
