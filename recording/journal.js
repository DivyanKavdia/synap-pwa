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
        // Keep 30-second local windows for crash recovery, but let the managed
        // cloud adapter combine ten immutable windows into one five-minute ASR
        // request. The policy is stored per recording so older 30-second cloud
        // recordings keep their original segment numbering after an upgrade.
        transcriptionWindowSeconds: 30,
        cloudTranscriptionWindowSeconds: 300,
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
