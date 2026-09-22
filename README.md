# Synap

**Repository reviewed: 22 September 2026**

Synap is the companion PWA and cloud memory platform for the Synap wearable family. Device firmware lives in `DivyanKavdia/synap-firmware`; this repository owns the browser experience, local durable journal, cloud API, processing pipeline, retrieval, memory surfaces and production deployment.

## Production truth

- **PWA:** `main` → GitHub Pages.
- **Current shell generation:** `1.0.0-shell162-ask-processing-fix`.
- **Backend:** Google Cloud Run in `asia-south1`, promoted only after readiness validation.
- **Firmware OTA baseline:** Synap OS build **1406** for Odyssey S3, Odyssey C3 and Chakshu. The OTA feed is authoritative; a newer firmware `main` commit is not a device release until published.
- **Runtime:** Node.js 22+ for local/CI tooling and the backend.

Do not hard-code application commit SHAs into operational documentation. Git history and Actions identify the deployed source; architecture docs describe the stable contract.

## Product surface

- **Memory** — daily/weekly views, source recordings, transcript, summary and provenance.
- **Actions** — commitments, waiting items and follow-ups projected from memories.
- **Ask Synap** — grounded recall over cloud memories with on-device/local recall fallback when cloud retrieval is unavailable.
- **People & speaker identity** — user-confirmed person names, remembered voices and recording-level speaker identity correction.
- **Unified memories** — merge consecutive memories, recreate the unified memory, unmerge without touching source recordings, share via WhatsApp/Gmail and export a PDF.
- **Devices** — connection, recording, battery/status, OTA and capability-aware controls.
- **Chakshu media** — connected photo/video capture plus disconnected Hey Snap + SD capture and verified sync-to-app.

## Device family

`devices/catalog.json` is the PWA mirror of the firmware device catalogue. IDs, OTA markers and BLE advertising identities are compatibility contracts; product display names are not wire identifiers.

| Product | Target | Module | Core capabilities |
| --- | --- | ---: | --- |
| **Synap Odyssey S3** | `esp32s3-fh4r2-qspi-4m` | 1 | audio, settings, touch, battery, standby |
| **Synap Odyssey C3** | `esp32c3-supermini-4m` | 2 | audio, settings, touch, battery, standby |
| **Chakshu** | `xiao-esp32s3-sense-8m` | 3 | audio, camera, SD, photo, video, SD audio, settings, touch, battery, standby |

Chakshu alone has camera, SD and the local Hey Snap runtime. When BLE is connected the PWA owns capture; when disconnected firmware owns Hey Snap and offline capture.

## End-to-end path

```text
Wearable
  ├─ BLE connected ───────────────> PWA capture
  └─ Chakshu disconnected ───────> SD offline capture
                                      │ verified sync
                                      v
PWA durable journal / local source
              │
              v
Synap Cloud API → encrypted storage + Firestore + Cloud Tasks
              │
              v
transcription → speaker attribution → memory extraction → retrieval/index
              │
              ├─ Memory / Brief / Actions / People
              └─ Ask Synap
```

The 30-second browser/cloud segment is a **durability and recovery boundary**, not necessarily one provider request. Long contiguous missing windows may be processed in bounded batches while retaining source-window provenance.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — end-to-end components, data flow and invariants.
- [Operations](docs/OPERATIONS.md) — CI/CD, production checks, recovery and troubleshooting.
- [Development and codebase](docs/DEVELOPMENT.md) — repo map, tests, catalog/version rules and cleanup policy.
- [Chakshu offline + Hey Snap](docs/CHAKSHU_OFFLINE_AND_HEY_SNAP.md) — single-owner BLE/offline contract, SD recovery and verified sync.
- [Automatic speech processing](docs/AUTOMATIC_SPEECH.md) — local enhancement, source preservation and resource limits.
- [RNNoise provenance](vendor/audio-enhancement/README.md) — bundled model/runtime provenance and licensing.

Firmware architecture, hardware pins, source materialization, voice training and OTA publication belong to the firmware repository.

## Local development

```sh
npm ci
npm ci --prefix backend
npx playwright install chromium

npm run dev
```

Open `http://localhost:4173`.

Before merging:

```sh
npm test
npm run typecheck
npm run test:backend
npm run test:browser
```

The production workflow also runs backend, Firestore, WebKit audio, browser workflow and infrastructure contract checks.

## Source-of-truth rules

1. `main` is the current application development baseline.
2. The firmware OTA feed, not a source commit, defines installable device firmware.
3. Firmware `devices/catalog.json` is the hardware/catalogue authority; this repo mirrors it.
4. Raw media, transcript source words and timestamps are never silently replaced by a derived enhancement, summary or corrected display name.
5. User speaker/name corrections update derived identity views; they do not re-transcribe audio.
6. A source memory remains intact when a unified memory is created, recreated or deleted.
7. A passing software pipeline does not replace physical-device acceptance testing.

Historical implementation detail belongs in Git history and release artifacts rather than parallel legacy code paths.
