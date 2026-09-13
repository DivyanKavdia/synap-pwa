# Synap architecture

The browser receives and journals pendant audio, then schedules processing and
renders locally saved memory. The managed backend authenticates the owner,
stores encrypted sources, runs transcription/memory extraction, and answers
questions using retrieved evidence. Firmware is a separate repository.

## Find the owner

| Responsibility                                                       | Source                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Startup graph and offline shell                                      | `index.html`, `sw.js`                                                          |
| Connection/recording policy and library controller                    | `app.js`                                                                       |
| Audio transport decoding                                             | `audio-codec-v3.js`                                                            |
| IndexedDB journal, recovery, segments and job persistence            | `audio-store.js`                                                               |
| Processing locks, dispatch, concurrency, pause and retry             | `processing-queue.js`                                                          |
| Native GATT queue and connection-generation ownership                | `recording/bluetooth-session.js`                                                     |
| Per-store pendant timeline and explicit capture options              | `recording/timeline.js`, `recording/journal.js`                                                         |
| Adopting hardware-started recording                                  | `recording-bridge.js`                                                          |
| Intentional sleep/reconnect preference                               | `sleep-state-guard.js`                                                         |
| Battery popover and idle standby control                             | `battery-popover-fix.js`                                                       |
| Session-bound recording notifications                                | `recording-notifications.js`, `sw.js`                                          |
| Google session, refresh and authenticated requests                   | `google-auth.js`                                                               |
| Cloud provider and memory/people/follow-up API client                | `synap-backend.js`                                                             |
| Provider preferences and legacy direct OpenAI processing             | `ai-providers.js`                                                              |
| Stalled cloud status recovery                                        | `processing-recovery.js`                                                       |
| Cloud history hydration and targeted restore                         | `cloud-history.js`, `experience-recovery.js`                                   |
| Legacy memory rebuild UI                                             | `transcript-repair.js`                                                         |
| Deduplicated completion notification                                 | `memory-ready-events.js`                                                       |
| Navigation and mounted panels                                        | `dashboard-ui.js`, `memory-workspace.js`, `my-actions.js`, `compact-layout.js` |
| Memory cards, merges and source-linked viewing                       | `memory-tools.js`, `provenance-links.js`                                       |
| Day summaries and weekly memory timeline                             | `brain-ui.js`, `productivity-tools.js`                                         |
| Action timelines and completion                                      | `interaction-surfaces.js`, `action-state.js`                                   |
| People identity and deletion                                         | `interaction-surfaces.js`, `people-confirm-ui.js`                              |
| Managed HTTP routes                                                  | `backend/src/http/app.ts`, `backend/src/http/routes/`                          |
| Managed processing orchestration                                     | `backend/src/pipeline/process.ts`                                              |
| Encryption and durable cloud storage                                 | `backend/src/crypto/`, `backend/src/store/`                                    |
| Acoustic embeddings                                                  | `speaker-service/app.py`                                                       |
| Deployment configuration                                             | `.github/workflows/`, `infra/terraform/`                                       |

The names of some older UI modules describe the repair that introduced them.
Consult this table before creating a second owner for the same responsibility.

## Browser startup

`index.html` declares the production scripts exactly once. Storage and the queue
load before recording hooks; auth and processing providers register before
`app.js` can resume pending jobs. Readiness events are available before the queue.
Recovery observes authenticated status responses through an explicit callback;
it does not replace `SynapAuth.authedFetch` or inject another script at runtime.

The service worker uses network-first code with an offline shell fallback. Cache
generation and script URLs must advance together. Normal updates preserve
IndexedDB. Reload is gated while recording, saving or updating firmware.

Pendant diagnostics in `enhancements.js` accept the legacy 32-byte v1 packet and
48-byte v2 packet. V2 adds the retained disconnect reason/count/time and last
notification error. Reads use the existing GATT queue only while idle. Results
flow through `app.js`'s bounded log, so Copy and Download preserve the same data
after later app messages. A rejection count measures failed local notification
attempts; retries can recover them, so it is separate from lost audio frames.

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

## Remaining maintenance work

`app.js` remains the connection/recording policy and library coordinator. The
native GATT queue has been extracted into `recording/bluetooth-session.js` and
storage no longer depends on prototype patches. Future extractions should move
recording transitions and Library rendering behind explicit interfaces while
preserving the real browser workflow checks.

Older presentation modules and CSS layers still overlap; several modules have
names inherited from earlier repairs. Some tests still inspect source strings.
Prefer behavior tests for each boundary as it changes. Do not introduce another
module that wraps existing methods at startup.

Backend processing now claims a recording through a transaction and fences each
attempt with a lease. `pipeline/index-memory.ts` prepares optional embeddings
outside Firestore, then commits conversations, people contributions, follow-ups
and the ready checkpoint together. Retries reuse sealed understanding and leave
completed tasks intact. Daily-brief recovery runs after publication, so a brief
failure does not hide the memory. `first-memory.js` consumes the existing Library
snapshot through an explicit callback; its illustrative sample never enters the
journal, cloud history or personal actions.

The emulator CI job exercises real SDK transactions without cloud credentials.
The emulator does not reproduce every production contention/size limit; physical
radio/audio testing and production monitoring remain separate release gates.

See [recording architecture audit](RECORDING_AUDIT.md) for findings, changes,
validation evidence and the physical-device acceptance boundary.
