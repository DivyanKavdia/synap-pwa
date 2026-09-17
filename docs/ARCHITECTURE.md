# Synap architecture

The PWA owns connection policy, durable local recordings, processing jobs and presentation. Firmware owns physical capture and reports capabilities. The managed backend authenticates the account, stores encrypted sources and derives memory from those sources.

## Source ownership

| Responsibility                                                             | Owner                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Startup dependency order and offline shell                                 | `index.html`, `sw.js`                                                          |
| Device definitions, identity, capabilities and settings                    | `devices/` — see [device capabilities](DEVICE_CAPABILITIES.md)                 |
| Chakshu capture, SD transfer, media library/player and voice/model clients | `devices/chakshu/` — see [Chakshu](CHAKSHU.md)                                 |
| Connection/recording policy and audio Library coordination                 | `app.js`                                                                       |
| Native GATT queue, deadlines and connection generations                    | `recording/bluetooth-session.js`                                               |
| Per-store sequence/timeline and explicit capture configuration             | `recording/timeline.js`, `recording/journal.js`                                |
| Audio transport decoding                                                   | `audio-codec-v3.js`                                                            |
| IndexedDB journal, segments, recovery, close/delete barriers and jobs      | `audio-store.js`                                                               |
| Hardware-started recording adoption                                        | `recording-bridge.js`                                                          |
| Intentional sleep/reconnect preference                                     | `sleep-state-guard.js`                                                         |
| Automatic standby / battery popover placement                              | `devices/power.js` / `battery-popover-fix.js`                                  |
| Session-bound recording notifications                                      | `recording-notifications.js`, `sw.js`                                          |
| Processing concurrency, cancellation and retries                           | `processing-queue.js`                                                          |
| Google session and account-bound requests                                  | `google-auth.js`                                                               |
| Managed provider and memory/people/follow-up client                        | `synap-backend.js`                                                             |
| Provider preferences and direct processing                                 | `ai-providers.js`                                                              |
| Stalled processing and cloud restoration                                   | `processing-recovery.js`, `cloud-history.js`, `experience-recovery.js`         |
| Legacy rebuild UI / completion events                                      | `transcript-repair.js` / `memory-ready-events.js`                              |
| Navigation and mounted panels                                              | `dashboard-ui.js`, `memory-workspace.js`, `my-actions.js`, `compact-layout.js` |
| Memory editing and source-linked views                                     | `memory-tools.js`, `provenance-links.js`                                       |
| Daily/weekly summaries                                                     | `brain-ui.js`, `productivity-tools.js`                                         |
| Actions and people controls                                                | `interaction-surfaces.js`, `action-state.js`, `people-confirm-ui.js`           |
| Managed HTTP boundaries                                                    | `backend/src/http/app.ts`, `backend/src/http/routes/`                          |
| Processing, window validation and derived indexing                         | `backend/src/pipeline/`                                                        |
| Encryption and durable cloud persistence                                   | `backend/src/crypto/`, `backend/src/store/`                                    |
| Speaker embeddings                                                         | `speaker-service/app.py`                                                       |
| Deployment                                                                 | `.github/workflows/`, `infra/terraform/`                                       |

Device code shares the existing recorder and GATT queue. Adding a camera or local command service must not create a second Bluetooth connection, replace recorder methods or capture audio through a parallel journal.

The four-destination workspace and its research/behavior are described in
[Product experience](PRODUCT_EXPERIENCE.md). `workspace.css` owns the final
workspace presentation; navigation hides inactive destinations without unmounting
source or recording controls.

## Startup and connection lifetime

`index.html` declares scripts once in dependency order. Profiles precede capability consumers; storage and processing precede recording hooks; authentication/providers register before `app.js` resumes jobs. Modules communicate through explicit APIs and events. The service worker uses network-first code with an offline fallback. Cache generation and changed script URLs advance together. Normal updates preserve IndexedDB and defer reload while recording, saving or updating firmware.

`app.js` publishes a physical connection through `devices/identity.js`. That lease lasts until the GATT connection changes. Recording generations have a separate lifetime, so starting/stopping audio does not invalidate the camera service. Optional work checks ownership immediately before native execution. Passive polling waits for idle; camera transfer is explicitly allowed during confirmed audio recording. Discovery can identify a module once during resumed audio, preventing a long recording from hiding its camera indefinitely.

A new page can encounter firmware still reporting STREAMING with MTU23 and zero payload because it retains an abandoned recovery session. With no matching recording owner, the PWA sends STOP and requires a valid idle acknowledgement before connecting normally. It retries while transport settles. Owned recovery sessions use their token/resume path instead. Invalid transport is never accepted as playable audio.

Chakshu transfer serializes an entire frame/file transaction while each GATT operation also uses the shared native queue. This prevents request/reply overlap without starving audio control. Stale connections, account changes and cancelled captures invalidate pending work. The ordinary audio journal is shared across all devices; video soundtracks receive their own recording ID and remain independent from silent visual frames.

## Diagnostics

`enhancements.js` reads legacy 32-byte v1 and 48-byte v2 diagnostics through the idle GATT queue. V2 adds disconnect reason/count/time and notification errors. Results enter the bounded `app.js` log, so Copy/Download retain firmware and app evidence together. Local notification rejection is separate from missing audio because a retry can succeed. Use [audio diagnostics](AUDIO_PIPELINE.md) to distinguish app-requested disconnects, physical link loss, browser suspension and corrupt PCM.

## Durable processing

`DKAudioStore` owns database version 3: recordings, packets, segments and jobs.
Packets are journaled before compaction. The store also owns rolling windows, close coalescing and deletion barriers. `recording/journal.js` supplies explicit constructor options; importing it never patches a prototype. Pendant clocks use a per-store `RecordingTimeline`; desktop PCM counters stay logical. Each 30-second segment feeds ordered
transcribe and summarize jobs; consolidation produces the recording memory.
Managed transcribe jobs upload a window and let the backend perform ASR. Capture owner metadata is committed with the recording. Managed jobs check that owner, pin requests to the selected account and abort on account changes. Older unowned recordings are assigned to the account used for their first managed sync. Cloud restore retains account ownership.

`DKFIFOProcessor` runs at most two jobs from different recordings under a Web
Lock. Jobs for the same recording remain ordered. Failed/recovering recordings
do not block other recordings. A selected retry preserves unrelated work and
successful stages. Pause aborts in-flight network work and resolves after those
jobs settle, so deletion cannot race an active job.

Providers register an adapter instead of replacing queue methods:

```js
DKFIFOProcessor.registerProvider('example', {
  async prepare(processor, config) {
    // Return a fresh configuration, or null with an onChange message if blocked.
    return {
      ...config,
      endpoint: 'https://example.test/stt',
      llmEndpoint: 'https://example.test/memory',
    };
  },
  timeout(job) {
    return job.kind === 'consolidate' ? 900000 : 120000;
  },
  async process(processor, job, config, signal) {
    // Use signal for requests; return fields to commit through finishJob.
    if (job.kind === 'transcribe') return { transcript: '...' };
    if (job.kind === 'summarize') return { summary: '...' };
    return { summary: '...', transcript: '...', processingState: 'done' };
  },
});
```

The provider name and prepared configuration stay fixed for a run. Custom HTTPS
endpoints use the built-in adapter. Missing configuration returns control to the
caller with the jobs pending. Managed configuration stays transient and never
overwrites the user's custom endpoint settings. Legacy failed finalize jobs have
a narrowly scoped migration; ordinary failures retain their retry state.

`finishJob` commits the output and completed job together, then returns the saved
record. The queue publishes `synap-processing-state` after each state write and
`synap-memory-ready` after consolidation commits. A failed save never reports
ready. UI callbacks cannot requeue an already committed result. Readiness does
not scan every recording or infer completion from queue-status DOM changes.

## Backend boundaries

User routes apply `requireAuth()` to the route they handle. Unrelated routers
do not repeatedly verify the session, read the user and unwrap the data key.
Cloud Tasks uses its separate OIDC guard; public health/auth endpoints retain
their own rules. Unmatched resources return 404.

`ask-v3.ts` is the sole `/v1/ask` handler. It combines structured, lexical/source
and semantic retrieval, then validates grounded answers and citations. Older Ask
implementations were unmounted or shadowed and have been removed.

`pipeline/rolling-transcription.ts` owns transcription of a stored window for both PUT retries and final processing. `pipeline/recording-segments.ts` validates the exact window sequence and joins all workers before failure. Finalize refuses missing windows before queuing understanding; timing headers must contain finite, ordered millisecond values.

Keep request validation at HTTP boundaries, encryption binding in the crypto
layer, and restart/idempotency logic in persistence and pipeline code. The
speaker service is a separate private service for embeddings. Browser-facing
code does not receive managed model credentials. Inline development secrets and
Secret Manager values pass through the same signing-key validation.

## Maintenance boundaries

`app.js` still coordinates recording policy and audio Library rendering. Older presentation modules contain some overlapping CSS/UI layers and repair-era names. Move a responsibility only when its lifetime and browser regression can move together. Do not add prototype wrappers or whole-document observers as integration mechanisms.

Processing claims use ownership fences. `pipeline/index-memory.ts` prepares optional embeddings outside Firestore, then commits derived rows and readiness together. Retries reuse sealed understanding and preserve completed tasks. Daily-brief failure does not hide an already published memory. `first-memory.js` reads an explicit Library snapshot; its sample never enters personal storage.

CI covers pure code, native firmware contracts, simulated browser workflows and disposable Firestore transactions. It does not establish microphone quality, sustained RF throughput, OS background behavior, power endurance or physical camera timing. Those remain device checks.
