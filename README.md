# Synap

**Current production baseline — 20 September 2026**

Synap is the companion application and cloud memory platform for the Synap wearable family. This repository owns the browser/PWA experience and the production backend. Device firmware is maintained separately in `DivyanKavdia/synap-firmware`.

## Production baseline

- **PWA:** deployed from `main` through GitHub Pages.
- **Backend:** Google Cloud Run, region `asia-south1`.
- **PWA application baseline:** `31803c596c8622388f512681bcaa05e89172018a` (shell revision `1.0.0-shell152-sd-probe-backoff`).
- **Backend application baseline:** `97ba01a`.
- **Firmware baseline:** Synap OS build **1366** (`synap-os1-build1366`) from `DivyanKavdia/synap-firmware`, source `cb5857df5290a22494c6901b12d61f35e15c12e2`.
- **Primary transcription:** `gemini-3.5-transcribe`.
- **Memory / reasoning:** Gemini models behind the Synap backend.
- **Storage and orchestration:** encrypted object storage, Firestore state, Cloud Tasks and the private speaker service.

The production backend is promoted only after a synthetic end-to-end readiness check validates session/key handling, audio storage, transcription, Cloud Tasks, memory creation, summaries, retrieval indexes, Ask Synap, voice profiles and cleanup.

## Current architecture

```text
Synap Odyssey C3 / Synap Odyssey S3 / Chakshu
        |
        | BLE
        v
Browser / PWA
        |
        | durable 30-second local recovery windows
        v
Synap Cloud API
        |
        +--> encrypted source audio / media metadata
        +--> Firestore processing state
        +--> Cloud Tasks
        |
        v
Gemini transcription
        |
        | bounded long-form file batches
        v
Transcript + memory extraction + retrieval
        |
        +--> Memories
        +--> Brief
        +--> Actions
        +--> Ask Synap
```

### Transcription invariant

The **30-second segment is a durability and recovery boundary, not the Gemini request boundary**.

Contiguous missing source windows are grouped into long-form provider batches. The current default is **20 minutes**, with a code hard cap of **25 minutes**. Word timestamps are projected back to the immutable source windows so existing recovery, playback and deletion semantics remain intact.

Missing, incomplete or rate-limited model responses are handled through durable retry/cooldown logic rather than immediate duplicate audio submission.

Batching is the primary defence against daily quota exhaustion: one request per twenty minutes instead of forty. When the dedicated ASR model is nonetheless blocked for hours, the batch is rescued **one 30-second window at a time on the fallback model**, which holds a separate quota. The long-form batch itself cannot use that model — it returns plain text, and word timestamps are the only thing that maps a twenty-minute response back onto the durable windows — but a single window is already its own boundary and needs no such map. Each rescued window is sealed and committed on its own, so a pass that runs out of request budget or meets a second cooldown keeps everything it finished and resumes from what is still missing.

## Product surface

Synap currently exposes:

- **Brief** — daily/weekly memory and priority view.
- **Memories** — source recordings, transcripts, summaries and evidence.
- **Actions** — commitments and follow-ups extracted from memory.
- **Ask** — grounded recall over stored Synap memories.
- **Device controls** — connection, recording, battery/status and firmware management.
- **Voice identity** — consented speaker profile and downstream speaker enrichment.
- **Chakshu media** — connected photo/video controls, SD/offline media metadata and digest-verified sync-to-app workflows.

## Device family

Three devices share one catalogue (`devices/catalog.json`), which is the source of truth for every capability gate in the app. Display names changed in this baseline; identifiers did not.

| Device | Board | Module | OTA marker | Capabilities |
| --- | --- | --- | --- | --- |
| **Synap Odyssey S3** | ESP32-S3 SuperMini (4 MB) | 1 | `SYNAP-ESP32S3-OTA-ID-V3` | audio, settings, touch, battery, standby |
| **Synap Odyssey C3** | ESP32-C3 SuperMini (4 MB) | 2 | `SYNAP-ESP32C3-OTA-ID-V3` | audio, settings, touch, battery, standby |
| **Chakshu** | XIAO ESP32-S3 Sense (8 MB) | 3 | `SYNAP-CHAKSHU-OTA-ID-V3` | audio, camera, SD, photo, video, SD audio, settings |

The renaming of C3 and S3 to **Synap Odyssey** is a display change only. Catalogue ids
(`esp32c3-supermini-4m`, `esp32s3-fh4r2-qspi-4m`), the BLE advertising name `synap`, OTA product
markers and manifest paths are wire and update identifiers and are unchanged. Changing any of them
would orphan devices already in the field.

Odyssey C3 and Odyssey S3 are audio pendants: no camera, no SD card, no wake engine. Everything
below about offline capture and Hey Snap applies to Chakshu alone.

### Chakshu baseline

The current companion flow supports the production Chakshu voice/media protocol, including:

- SD clear and Synap-owned FIFO space management.
- SD is the disconnected/offline capture inbox; it is mounted at Chakshu boot and its readiness is always surfaced to the PWA.
- **BLE connected:** PWA owns commands and all new audio/photo/video capture; media saves directly into the app.
- **BLE disconnected:** firmware owns Hey Snap; supported standalone captures save to SD.
- Reconnect catalogues SD without deleting anything and flags unsynced audio, photos and video.
- When firmware reports SD unavailable, shell152 performs only one recovery catalogue probe per BLE connection instead of repeatedly occupying the shared media queue; an explicit **Check SD card**, a new device, or a reconnect permits a fresh probe.
- Firmware build 1366 corrects SD diagnostics: `sdClockHz` is the clock attempted by the current mount try, and `sdMountStage` distinguishes `bus` from `no-card`, avoiding false conclusions from stale/default clock values.
- **Sync to app** verifies imported bytes before deleting each SD source; failed verification keeps the original.
- Local `Hey Snap` command recognition in firmware.
- Imported standalone SD audio enters the normal transcription and memory pipeline.

#### One owner at a time

**Hey Snap runs only while Chakshu is not connected to the PWA over BLE.** When the app holds the
link it is the single source of commands and operations. Firmware also enforces this boundary:
connect stands local voice down and every disconnect re-arms it, including an unexpected link loss.
Connected clients cannot start SD audio/video recording. See
[`docs/CHAKSHU_OFFLINE_AND_HEY_SNAP.md`](docs/CHAKSHU_OFFLINE_AND_HEY_SNAP.md) for the protocol,
offline inbox and verified-sync contract.

## Source-of-truth rules

1. `main` is the only current development baseline.
2. Historical architecture decisions live in Git history, merged PRs and releases—not in parallel design documents.
3. Device capability truth comes from the synchronized device catalog and firmware capability protocol.
4. Original source media is not replaced by an enhanced or accelerated inference copy.
5. A successful software build does not replace physical device acceptance testing.

## Development

Node.js 22 or later is required.

```sh
npm ci
npm ci --prefix backend
npx playwright install chromium
npm run dev
```

Open `http://localhost:4173`.

Before merging application changes:

```sh
npm test
npm run typecheck
npm run test:backend
npm run test:browser
```

The backend has its own unit/integration validation under `backend/`.

## Deployment

### PWA

Changes reaching `main` are validated and GitHub Pages publishes the browser application.

### Backend

Backend-affecting changes on `main` trigger the production deployment workflow. The workflow:

1. runs backend type checks and tests,
2. builds and pushes the container,
3. deploys a zero-traffic Cloud Run candidate,
4. executes production-dependency readiness checks,
5. promotes the verified revision to 100% traffic,
6. leaves rollback instructions if promotion fails.

Terraform remains reviewed infrastructure-as-code and is not implicitly applied by ordinary application pushes.

## Physical acceptance boundary

Software CI verifies protocol, storage, recovery, browser workflows and backend processing. Physical acceptance is still required for:

- sustained BLE microphone delivery,
- reconnect behavior under real radio conditions,
- local `Hey Snap` recognition,
- camera quality,
- long SD recording and FIFO behavior,
- move-to-app/delete behavior,
- complete device → transcript → memory flow.

The current hardware baseline for acceptance testing is **firmware build 1366** with PWA shell
`1.0.0-shell152-sd-probe-backoff`.

Build 1366 already contains the BLE ownership and SD boot/re-detection implementation: Hey Snap is
stood down for the BLE-connected period and re-armed by firmware on every disconnect, including
unexpected drops. Physical acceptance still needs to confirm that behavior on-device, that SD is
ready after cold boot/re-detection, and that unsynced offline captures survive failed transfers.
The current personalized TinyML model does not yet contain a dedicated spoken **Start audio** class,
so offline WAV transport/sync is supported but that spoken command is not a production claim yet.

## Working convention from this baseline

New work starts from current `main`. Do not revive superseded feature branches or old design PRs. Keep documentation in this README current and concise; use code, tests, releases and Git history as the detailed audit trail.
