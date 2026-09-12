# Synap architecture

The browser receives and journals pendant audio, then schedules processing and
renders locally saved memory. The managed backend authenticates the owner,
stores encrypted sources, runs transcription/memory extraction, and answers
questions using retrieved evidence. Firmware is a separate repository.

## Find the owner

| Responsibility                                                       | Source                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| Startup graph and offline shell                                      | `index.html`, `sw.js`                                   |
| BLE connection, serialized GATT, recording state, library controller | `app.js`                                                |
| Audio transport decoding                                             | `audio-codec-v3.js`                                     |
| IndexedDB journal, recovery, segments and job persistence            | `audio-store.js`                                        |
| Processing locks, dispatch, concurrency, pause and retry             | `processing-queue.js`                                   |
| Closing 30-second processing windows during a take                   | `rolling-transcription.js`                              |
| Same-take sequence continuity                                        | `capture-stability.js`                                  |
| Adopting hardware-started recording                                  | `recording-bridge.js`                                   |
| Intentional sleep/reconnect preference                               | `sleep-state-guard.js`                                  |
| Battery popover and idle standby control                             | `battery-popover-fix.js`                                |
| Session-bound recording notifications                                | `recording-notifications.js`, `sw.js`                   |
| Google session, refresh and authenticated requests                   | `google-auth.js`                                        |
| Cloud provider and memory/people/follow-up API client                | `synap-backend.js`                                      |
| Provider preferences and legacy direct OpenAI processing             | `ai-providers.js`                                       |
| Stalled cloud status recovery                                        | `processing-recovery.js`                                |
| Cloud history hydration and targeted restore                         | `cloud-history.js`, `experience-recovery.js`            |
| Legacy memory rebuild UI                                             | `transcript-repair.js`                                  |
| Deduplicated completion notification                                 | `memory-ready-events.js`                                |
| Navigation and mounted panels                                        | `dashboard-ui.js`, `my-actions.js`, `compact-layout.js` |
| Memory cards, merges and source-linked viewing                       | `memory-tools.js`, `provenance-links.js`                |
| Day, people and action presentation                                  | `brain-ui.js`, `productivity-tools.js`                  |
| Managed HTTP routes                                                  | `backend/src/http/app.ts`, `backend/src/http/routes/`   |
| Managed processing orchestration                                     | `backend/src/pipeline/process.ts`                       |
| Encryption and durable cloud storage                                 | `backend/src/crypto/`, `backend/src/store/`             |
| Acoustic embeddings                                                  | `speaker-service/app.py`                                |
| Deployment configuration                                             | `.github/workflows/`, `infra/terraform/`                |

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

## Durable processing

`DKAudioStore` owns database version 3: recordings, packets, segments and jobs.
Packets are journaled before compaction. Each 30-second segment feeds ordered
transcribe and summarize jobs; consolidation produces the recording memory.
Managed transcribe jobs upload a window and let the backend perform ASR.

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

Keep request validation at HTTP boundaries, encryption binding in the crypto
layer, and restart/idempotency logic in persistence and pipeline code. The
speaker service is a separate private service for embeddings. Browser-facing
code does not receive managed model credentials. Inline development secrets and
Secret Manager values pass through the same signing-key validation.

## Remaining maintenance work

`app.js` still combines connection, recording and library controllers. The next
useful extraction is its GATT/session controller, backed by the existing
connection and OTA browser workflows. Do not split it by arbitrary line count.

Rolling windows and sequence normalization still wrap storage methods. They are
now separate modules with an explicit load order; moving these into storage
lifecycle methods needs transaction/recovery tests. Several older UI files and
CSS layers remain compressed, and some tests still match source strings. Migrate
those incrementally alongside behavior coverage instead of introducing another
format-sensitive assertion.

Review included PWA/backend source, deployment entry points, the speaker service
boundary, and firmware contracts at `346b819caf89d3ed3ac2d401dce939237f9c5390`.
Firmware source and public BLE protocol versions were not changed in this pass.
