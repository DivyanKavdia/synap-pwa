# Synap architecture

**Reviewed: 7 October 2026**

This document describes the current production architecture. It deliberately avoids historical build-by-build narrative.

## 1. System boundaries

Synap has three execution domains:

1. **Wearable firmware** — captures device audio/media and exposes BLE protocols. C3 + SD owns disconnected touch-initiated WAV; Chakshu owns SD captures from Hey Snap whether BLE is available or not while PWA capture is idle.
2. **PWA** — owns the connected user experience, local durable journal, playback/source retention, device control and cloud upload/recovery.
3. **Synap Cloud** — authenticates accounts, stores encrypted source/derived state, runs processing, indexes memories and serves Ask/People/Actions.

The core rule is one owner per hardware operation. A connected **PWA-initiated** capture is PWA-owned; **Chakshu Hey Snap** captures remain SD-owned whenever PWA capture is idle. C3 + SD does not redirect an in-progress offline WAV merely because BLE reconnects.

## 2. Device and capability model

The firmware repository owns the canonical `devices/catalog.json`. The PWA mirror generates `devices/profiles.js`.

Stable identifiers:
- target id;
- module id;
- OTA marker and manifest path;
- BLE advertising identity where used;
- protocol versions.

Display names may change without changing those compatibility identifiers.

There are **four functional variants on three OTA targets**: Odyssey S3; standard Odyssey C3 without SD; Odyssey C3 + SD; and Chakshu. Both C3 variants share target `esp32c3-supermini-4m`, module 2 and one OTA image. C3 storage-related support in the catalogue is not evidence of a physically mounted/ready card. The firmware [variant mapping](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/FIRMWARE_VARIANTS.md) is the product-behavior source of truth.

Chakshu's current hardware profile also exposes the shared touch (GPIO1 / D0), battery (GPIO2 / D1 with the S3 divider calibration), standby and status-NeoPixel (GPIO5 / D4) controls, while camera, SD and local Hey Snap remain Chakshu-specific capabilities.

## 3. Capture and local durability

### Connected audio

The browser receives framed BLE audio and writes durable local recovery windows. The active recording remains recoverable across transient background/storage failures. A successful BLE notification is not considered durable until browser storage accepts it.

### Connected Chakshu photo/video

Connected capture belongs to the app. Media is transferred into browser-owned storage and represented in Library/Memory surfaces.

### Standard C3 and C3 + SD

The **standard C3** records through BLE while connected and has no disconnected local recording when SD is absent/unmounted. **C3 + SD** uses the same firmware identity and adds local storage only when the card is healthy and ready.

The canonical low-level implementation is documented in the firmware repository at [Odyssey C3 SD architecture](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/ODYSSEY_C3_SD_AUDIO.md). The physically validated path uses Arduino-ESP32 3.3.5 SD/SPI at a retained 1 MHz runtime clock, 4 KiB multi-sector PCM writes, append-only STOP behavior, virtual WAV-header synthesis during transfer, bounded card re-arm, and a C3-only CMD24 busy-completion patch.

Disconnected double tap toggles a local 16 kHz WAV with a purple indicator. A reconnect does not change an active take's destination; a subsequent PWA START finalizes/releases the local take before taking microphone ownership. Connected PWA audio uses the normal live recording journal and green indicator.

With BLE connected, the PWA lists C3 SD WAV files. The media-v1 operation-4 request addresses the file on every chunk (or `@catalogue` for catalogue reads) to prevent background catalogue refreshes from invalidating transfers.

The PWA sync transaction is deliberately split into **durability** and **retention**:

1. download the SD source;
2. import it into Memories;
3. verify the imported copy;
4. persist a receipt keyed to the device/path;
5. mark the still-present SD file **Synced to Memories**;
6. ask the user whether to delete the SD copy.

A retained verified SD file is not pending work and must not be imported again. **Delete from SD** is available before sync (with a destructive warning) and after sync (while preserving the Memory). Explicit recovery is separate from ordinary read/list operations.

### Chakshu offline and Hey Snap

Chakshu writes voice-initiated photo, video and WAV captures under `/synap` on SD while PWA capture is idle, whether BLE is connected or disconnected. A PWA START suspends conflicting Hey Snap activity until the PWA-owned capture completes. Disconnected TTP double tap toggles SD audio; connected TTP routes audio to PWA. Reconnect catalogue is non-destructive; verified sync imports first and deletes the SD source only after durable-copy verification.

See [Chakshu offline + Hey Snap](CHAKSHU_OFFLINE_AND_HEY_SNAP.md).

## 4. Cloud processing

The recording state machine is:

```text
created → uploading → uploaded → transcribing → understanding → indexing → ready
                                      └──────────────────────────────→ failed
```

Important invariants:

- 30-second windows are durability/recovery units.
- Provider transcription may combine contiguous windows into bounded long-form requests.
- Completed segment transcripts are sealed independently, so retries resume from missing work.
- Processing leases fence stale workers.
- Provider cooldowns are represented durably instead of hammering the same audio.
- A ready memory is not downgraded merely because a later daily-brief refresh fails.

The UI reconciles stale progress metadata against actual saved transcript/memory content: a saved transcript means transcription is complete; a saved memory means the recording is ready.

## 5. Transcript and speaker identity

The immutable source is the transcript text/timestamps and source speaker labels produced from audio.

Speaker display names are a separate encrypted mapping:

```text
source label S1 ──> confirmed/identified person name
```

Recording-level **Edit speaker identity**:
- validates labels against the source transcript;
- updates the encrypted label→name map;
- rebuilds memory/indexed derivatives;
- refreshes transcript listeners;
- never re-transcribes audio.

People-level **Edit name**:
- changes the canonical person profile;
- scopes modern recording propagation by canonical `personId`;
- updates matching speaker mappings;
- rehydrates affected transcripts from the cloud source endpoint;
- uses bounded name matching only for legacy records that predate person linkage.

This separation prevents name edits from changing source words or timestamps.

## 6. Memory model

A ready recording can hold:
- sealed transcript;
- structured memory;
- speaker name/identity metadata;
- indexed conversations;
- projected actions/follow-ups;
- person associations;
- provenance back to source recording and offsets.

Daily/weekly surfaces are derived views. Source recordings remain the durable provenance boundary.

### Unified memories

A merge combines 2–5 consecutive ready memories from the same day into a separate encrypted derived memory. Source recordings are not mutated.

Operations:
- create merge;
- recreate/regenerate from the current source memories;
- unmerge by deleting only the derived merge;
- share structured unified memory via WhatsApp/Gmail;
- export structured unified memory as PDF.

## 7. Ask Synap

Ask first uses cloud grounded retrieval over indexed conversations and transcript evidence. Retrieval is bounded and individual unreadable historical records are isolated rather than failing the whole query.

If the cloud Ask path is temporarily unavailable, the PWA falls back to local recall over saved device memories. The UI states when local recall is being shown.

Ask does not treat a model answer as source evidence; results retain recording/conversation provenance.

## 8. People, actions and voice identity

People are canonical encrypted profiles with stable person IDs and alias keys. User confirmation prevents a model-derived name from silently overwriting a correction.

Remembered voices are separately consented encrypted voice profiles. They enrich future speaker identification; editing a transcript name does not silently collect a new biometric sample.

Actions are projected from structured memory and keep source recording/conversation links. User edits are preserved independently of later memory refreshes.

## 9. Storage and encryption

User content is sealed with the account data-encryption key before persistent cloud storage. Firestore plaintext fields are limited to operational/index fields required for filtering, ordering and lifecycle management.

Raw audio/media and derived memory are distinct objects. Enhancements are copies; source media remains available subject to the explicit retention policy.

## 10. PWA shell and update model

`index.html` is network-first navigation. JavaScript/CSS are network-first under the service worker; non-code static assets may be cache-first.

`CACHE_REVISION` / `UI_RECOVERY_REVISION` identify a shell generation. Asset query revisions are bumped when a specific client file must be refreshed. BLE/audio protocol compatibility is versioned separately and must not be changed just to refresh UI code.

## 11. Backend route ownership

The HTTP app mounts explicit route modules for auth, recordings/source, retry, tasks, Ask, Brain/People/Actions, speaker names, known speakers, voice profile, Chakshu, memory tools and operations/readiness.

All backend source modules are reachable from the production entry point or a production route/pipeline module. Tests and deploy-only readiness paths are separate from user traffic.

## 12. Physical acceptance boundary

CI can prove protocol contracts, source generation, browser workflows, cloud state transitions and deterministic storage/recovery logic. It cannot prove:
- RF quality;
- microphone placement/quality;
- SD/card/contact quality;
- camera image quality;
- real-world wake-word accuracy;
- battery/power behavior on a physical unit.

Those remain explicit device acceptance tests.

### Chakshu low-power indicator ownership

Only the external D4 / GPIO5 NeoPixel is a Synap status indicator. GPIO21 belongs to the Sense SD path; because the board's active-low orange USER_LED is electrically tied to that line, visible orange flashes are treated as SD bus activity, not product status. Background SD discovery is bounded to one automatic catalogue read per BLE connection to reduce both SPI traffic and incidental orange LED activity.
