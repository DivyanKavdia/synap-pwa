# Synap

**Repository reviewed: 1 October 2026**

Synap is the companion PWA and cloud memory platform for the Synap wearable family. Device firmware lives in `DivyanKavdia/synap-firmware`; this repository owns the browser experience, local durable journal, cloud API, processing pipeline, retrieval, memory surfaces and production deployment.

## Production truth

- **PWA:** `main` → GitHub Pages.
- **Current checked-in shell generation:** `1.0.0-shell176-device-controls` (the installed browser may still need a refresh).
- **Backend:** Google Cloud Run in `asia-south1`, promoted only after readiness validation.
- **Firmware OTA release checked at this review:** Synap OS build **1546** for three compiled targets (S3, C3 and Chakshu), covering **four functional device variants**. The OTA feed is authoritative; verify the installed build separately.
- **Runtime:** Node.js 22+ for local/CI tooling and the backend.

Do not hard-code application commit SHAs into operational documentation. Git history and Actions identify the deployed source; architecture docs describe the stable contract.

## Product surface

- **Memory** — daily/weekly views, source recordings, transcript, summary and provenance.
- **Actions** — commitments, waiting items and follow-ups projected from memories.
- **Ask Synap** — grounded recall over cloud memories with on-device/local recall fallback when cloud retrieval is unavailable.
- **People & speaker identity** — user-confirmed person names, remembered voices and recording-level speaker identity correction.
- **Unified memories** — merge consecutive memories, recreate the unified memory, unmerge without touching source recordings, share via WhatsApp/Gmail and export a PDF.
- **Devices** — connection, recording, battery/status, OTA, idle-only Restart Device on compatible firmware and capability-aware controls.
- **C3 + SD** — disconnected double tap records WAV to SD (purple pulse); connected PWA audio uses BLE (green pulse); pending local WAV files can be verified and synced to Memories.
- **Chakshu media** — PWA controls capture directly to the phone when connected; Hey Snap captures to SD while PWA capture is idle (BLE may be connected or not); TTP sends audio to phone when connected and SD when disconnected.

## Device family

`devices/catalog.json` is the PWA mirror of the firmware device catalogue. IDs, OTA markers and BLE advertising identities are compatibility contracts; product display names are not wire identifiers.

| Functional variant | Firmware target | Module | Device/PWA behavior |
| --- | --- | ---: | --- |
| **Odyssey S3** | `esp32s3-fh4r2-qspi-4m` | 1 | Connected BLE/PWA audio; no local SD recorder |
| **Odyssey C3 (standard, no SD)** | `esp32c3-supermini-4m` | 2 | Connected BLE/PWA audio; no offline storage without a mounted card |
| **Odyssey C3 + SD** | **Same C3 target** | 2 | Connected BLE audio; disconnected touch-initiated SD WAV, catalogue and verified sync |
| **Chakshu** | `xiao-esp32s3-sense-8m` | 3 | Connected PWA audio/photo/video, plus local Hey Snap SD media whenever PWA capture is idle |

There are **four functional variants but three compiled firmware/OTA targets**. Standard C3 and C3 + SD use the same image and identity; the SD-specific UI requires a healthy, mounted card, not just firmware support. The firmware [variant mapping](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/FIRMWARE_VARIANTS.md) is authoritative.

Chakshu alone has the **camera and local Hey Snap** runtime; **C3 + SD also has offline SD audio**. Chakshu Hey Snap remains armed with BLE either connected or disconnected while PWA capture is idle, and its voice-initiated media goes to SD. Active PWA audio/video suspends Hey Snap. Across compatible devices, connected touch initiates PWA audio; disconnected touch records locally only on C3 + SD or Chakshu with ready storage.

## End-to-end path

```text
Odyssey S3 / standard C3 ── BLE connected audio ──> phone/PWA
C3 + SD ────────────────┬─ BLE connected audio ───> phone/PWA
                       └─ disconnected double tap -> SD WAV ──┐
Chakshu ────────────────┬─ PWA controls + BLE ───> phone/PWA  │
                       ├─ Hey Snap (PWA idle) -> SD media ────┤
                       └─ disconnected TTP -> SD WAV ────────┤
                                                             v
                                               PWA verified SD import
                                               (delete SD original only
                                                after durable verification)
                                                             │
                 phone/PWA recording journal <────────────────┘
                              │
                              v
Synap Cloud API -> encrypted storage + Firestore + Cloud Tasks
                              │
                              v
transcription -> speaker attribution -> memory extraction -> retrieval
                              ├─ Memory / Brief / Actions / People
                              └─ Ask Synap
```

The 30-second browser/cloud segment is a **durability and recovery boundary**, not necessarily one provider request. Long contiguous missing windows may be processed in bounded batches while retaining source-window provenance.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — end-to-end components, data flow and invariants.
- [Operations](docs/OPERATIONS.md) — CI/CD, production checks, recovery and troubleshooting.
- [Development and codebase](docs/DEVELOPMENT.md) — repo map, tests, catalog/version rules and cleanup policy.
- [Chakshu offline + Hey Snap](docs/CHAKSHU_OFFLINE_AND_HEY_SNAP.md) — source-based command routing, SD recovery and verified sync.
- [Firmware variants](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/FIRMWARE_VARIANTS.md) — authoritative four-variant behavior, three-target OTA mapping and C3 + SD lifecycle.
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
