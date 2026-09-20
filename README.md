# Synap

**Current production baseline — 20 September 2026**

Synap is the companion application and cloud memory platform for the Synap wearable family. This repository owns the browser/PWA experience and the production backend. Device firmware is maintained separately in `DivyanKavdia/synap-firmware`.

## Production baseline

- **PWA:** deployed from `main` through GitHub Pages.
- **Backend:** Google Cloud Run, region `asia-south1`.
- **PWA application baseline:** `aa19647` (shell revision `1.0.0-shell150-hey-snap-ble-gate`).
- **Backend application baseline:** `97ba01a`.
- **Firmware baseline:** Synap OS build **1351** from the firmware repository.
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

## Product surface

Synap currently exposes:

- **Brief** — daily/weekly memory and priority view.
- **Memories** — source recordings, transcripts, summaries and evidence.
- **Actions** — commitments and follow-ups extracted from memory.
- **Ask** — grounded recall over stored Synap memories.
- **Device controls** — connection, recording, battery/status and firmware management.
- **Voice identity** — consented speaker profile and downstream speaker enrichment.
- **Chakshu media** — photo/video controls, SD/offline media metadata and move-to-app workflows.

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
- Verified move-to-app semantics before deleting the source SD object.
- Offline audio and video capture on SD, at 15, 30 or 60 seconds and two quality profiles.
- Local `Hey Snap` command recognition in firmware.
- Photo capture and explicit “what do you see” vision workflow.
- Imported offline audio entering the normal transcription and memory pipeline.

#### One owner at a time

**Hey Snap runs only while Chakshu is not connected to the PWA over BLE.** When the app holds the
link it is the single source of commands and operations, so it stands the firmware wake engine down
on connect and hands it back on disconnect. Running both at once put two command sources on one
serialized Bluetooth queue and cost the SD mount and the audio transport; see
[`docs/CHAKSHU_OFFLINE_AND_HEY_SNAP.md`](docs/CHAKSHU_OFFLINE_AND_HEY_SNAP.md) for the protocol,
the opcodes, the failure signature and the outstanding firmware requirement.

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

The immediate hardware baseline for that acceptance testing is **firmware build 1351**.

Build 1351 additionally requires physical verification that the firmware **re-arms the Hey Snap
wake engine whenever the BLE link drops**, including unexpected disconnects. The app re-enables it
before a disconnect it initiates, but cannot write anything when the pendant goes out of range or
the battery dies.

## Working convention from this baseline

New work starts from current `main`. Do not revive superseded feature branches or old design PRs. Keep documentation in this README current and concise; use code, tests, releases and Git history as the detailed audit trail.
