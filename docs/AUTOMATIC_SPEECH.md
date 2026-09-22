# Automatic speech, speaker identity and transcript refresh

**Reviewed: 22 September 2026**

This document covers the complete audio → transcript → speaker identity → memory flow. Chakshu's disconnected TinyML command classifier is a different subsystem; see [Chakshu offline + Hey Snap](CHAKSHU_OFFLINE_AND_HEY_SNAP.md).

## 1. Source path

```text
device PCM / imported WAV
        ↓
browser durable journal
        ↓
encrypted cloud source windows
        ↓
transcription
        ↓
word timestamps + source speaker labels
        ↓
optional diarization / voice matching
        ↓
user-confirmed identity mapping
        ↓
structured memory
        ↓
conversation index / People / Actions / daily brief / Ask
```

The retained source audio and original transcript words/timestamps are the provenance authority. Enhancements, names, summaries and indexes are derived state.

## 2. Local audio enhancement

Synap can create a locally enhanced speech copy for playback or bounded upload preparation.

```text
source WAV
  → validate PCM16 mono / supported rate
  → dedicated Worker
  → resample to 48 kHz when required
  → RNNoise suppression
  → delay compensation + bounded correction
  → resample to 16 kHz
  → derived WAV
```

The pinned RNNoise runtime and license/provenance details are documented in [the vendor README](../vendor/audio-enhancement/README.md).

Invariants:

- source Blob/recording stays unchanged;
- enhancement never writes IndexedDB by itself;
- enhancement never calls a cloud provider by itself;
- cancellation terminates the Worker and discards partial output;
- noise suppression cannot repair packet loss, clipping, missing speech or overlapping speakers.

## 3. ASR preparation

The backend accepts the stored source verbatim as the recovery input.

For compatible WAV audio it may create a disposable, pitch-preserving 1.5× FFmpeg copy for transcription efficiency. That copy never replaces the source and carries explicit usage metadata.

Exact digital silence can skip a provider call. Quiet or uncertain audio is not treated as silence.

## 4. Durable windows and long-form batching

The cloud storage/recovery unit is normally a 30-second source window.

Each window can retain:

- source storage path and digest;
- transcript;
- word annotations;
- transcription lease;
- review/quality metadata.

For long recordings, contiguous missing windows may be sent in one bounded provider request, then projected back onto the exact source windows.

This separates **durability granularity** from **provider request granularity**.

## 5. Restart safety and leases

Before paid transcription, a worker claims the relevant window(s).

Rules:

1. a completed sealed transcript/word set is reused;
2. a current lease prevents another worker from paying for the same source;
3. an ambiguous timeout may leave the lease to expire rather than immediately issuing another paid call;
4. completed rescue windows remain committed even if a later window fails;
5. the next task resumes only missing work.

## 6. Provider cooldown continuity

Primary and fallback transcription models can have separate quotas.

A sufficiently long primary-model cooldown can trigger bounded per-window fallback work where that fallback can preserve the required semantics. Completed windows are sealed immediately.

Service-wide cooldown state is persisted so different Cloud Run instances do not independently rediscover and hammer the same provider limit.

## 7. Transcript materialization

The canonical transcript can be reconstructed from:

1. a valid sealed recording transcript;
2. sealed segment transcripts;
3. grounded legacy segment text anchored to its stored segment start.

Materialization is used by:

- recovery;
- source endpoint rehydration;
- speaker/name correction;
- Ask transcript fallback;
- memory-only rebuilds.

## 8. Speaker labels vs person identity

These are deliberately separate:

- **source label** — `S1`, `S2`, `YOU`, etc.;
- **automatic identity estimate** — optional known-voice/self match;
- **confirmed display identity** — user-approved label→name mapping;
- **canonical person** — stable People entity with `personId`.

A model/voice estimate must never silently become a permanent user correction.

## 9. Recording-level Edit speaker identity

When the user edits speaker identity on one recording, the backend:

1. materializes the original transcript;
2. validates that submitted labels still exist;
3. stores the encrypted label→name mapping;
4. applies names only to the rendered/model-input transcript;
5. regenerates structured memory with confirmed speaker context;
6. republishes derived indexes/People/Actions;
7. rebuilds the daily brief;
8. returns the refreshed attributed transcript.

No STT call is made.

The PWA updates the visible transcript and emits:

- `synap-transcript-updated`;
- `synap-memory-ready`;
- `synap-cloud-history-updated`.

## 10. People-level Edit name

Changing a person name is broader than editing one recording.

The backend:

1. updates the canonical encrypted person profile;
2. retains alias keys so later model output using an older name still resolves to the same person;
3. finds modern recordings linked through `indexedPersonIds`;
4. updates only speaker-map values associated with the old display name;
5. uses a bounded name scan only for legacy records that predate `indexedPersonIds`;
6. returns `refreshed_recording_ids`.

The PWA rehydrates each affected recording through `/v1/recordings/{id}/source` and emits `synap-transcript-updated`.

This changes display identity only. Source words/timestamps are not rewritten and no voice is enrolled.

## 11. Remembered voices

Remembered voices are optional encrypted account data and require explicit consent/action.

A remembered profile can have a small bounded set of references. New samples must agree with the selected saved voice before they are attached.

Removing a saved voice stops future acoustic matching. Existing recordings remain intact.

A People rename is not itself voice enrollment. If voice-label naming is ever synchronized in future, it must preserve that consent boundary.

## 12. Memory-only rebuilds

A recording can require regenerated memory without new transcription.

Examples:

- speaker identity correction;
- transcript/source repair;
- rebuilding indexes after derived-state failure.

The pipeline can reuse sealed source transcripts, preserve confirmed speaker mappings and republish derived memory/index state without paying for STT again.

## 13. Ask Synap transcript evidence

Ask prefers indexed conversation evidence. If indexes are incomplete, it can inspect a bounded set of materialized transcripts.

The fallback:

- uses bounded concurrency;
- isolates unreadable historical recordings;
- stops early when enough targeted evidence exists;
- retains recording/conversation provenance.

If cloud Ask itself is unavailable, the browser can show local recall instead.

## 14. UI status reconciliation

Processing metadata can become stale after background suspension or delayed updates.

The UI treats actual saved content as stronger evidence:

- structured memory exists → Ready;
- transcript exists but state says uploaded/transcribing → transcription is complete; remaining work is understanding/summarization.

Do not trigger re-transcription simply to repair a stale badge.

## 15. Verification

Key test surfaces include:

```sh
node --test tests/audio-enhancement.cjs
node tools/audio-enhancement-smoke.cjs
npm run test:backend
npm run test:browser
```

Backend tests cover transcription recovery, cooldowns, source materialization, speaker names, voice profiles and memory grounding.

Software tests do not prove microphone acoustics or real-world speaker-recognition quality. Physical/audio acceptance should record the device, firmware build, environment and source sample used.
