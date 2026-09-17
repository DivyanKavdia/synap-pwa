# synap — PWA

**Stay present. Keep the memory.**

Synap is the companion experience for the Synap wearable family. It receives pendant audio over Bluetooth, preserves recordings, turns conversations into grounded searchable memory, surfaces follow-through, and manages device health and firmware updates. Chakshu extends the same experience with camera capture and a local photo/video library. Firmware lives in [synap-firmware](https://github.com/DivyanKavdia/synap-firmware).

## The current Synap experience

The app is organized around four persistent destinations:

- **Brief** — a compact daily or weekly view of what happened, what matters and what needs attention. Activity metrics and priorities link back to their source memories.
- **Memories** — recordings, transcripts, summaries and source evidence. Recognition preserves the complete transcript before optional speaker annotations, and readable transcript windows can appear before final summarization completes.
- **Actions** — evidence-backed commitments and follow-ups extracted from conversations, with ownership, deadlines and stable status. Actions refresh when new memory processing completes.
- **Ask** — grounded recall across captured memories. Answers are scoped to available Synap sources rather than presented as unsupported recollection.

Recording and device controls remain available across navigation. The responsive header keeps connection, battery, microphone and supported camera/video controls together without taking over the workspace.

## Recording → memory → follow-through

Connect a pendant through the device picker and start listening from the microphone control. Synap journals a recording before processing so the source remains recoverable, then makes it available for playback or WAV export. Compatible firmware can replay a short volatile buffer after a brief Bluetooth interruption; it is not unlimited background storage.

After capture, Synap preserves the source recording and complete transcript, then adds optional speaker information, grounded summaries and actionable outcomes. Optional speaker-label failures or timeouts do not discard an already completed transcription. Source evidence remains the basis for summaries, Brief items, Actions and Ask results.

On iPhone, keep Synap visible in Bluefy with the screen unlocked while recording. See [recording lifecycle](docs/RECORDING_LIFECYCLE.md), [audio pipeline](docs/AUDIO_PIPELINE.md), [background limits](docs/BACKGROUND_RECORDING.md) and [transcription quality and recovery](docs/TRANSCRIPTION_QUALITY.md).

## Voice identity

A user can set their name and, with consent, enroll a bounded voice sample. Synap keeps the completed sample visible while the private speaker profile is being saved and reports save failures explicitly. Delayed saves and timeouts do not silently restart the microphone.

When speaker timing is available, a consented enrolled profile can be used conservatively to identify the wearer by their confirmed name. Recognition and speaker identification are separate stages: speaker-service failure must not invalidate the underlying transcript. See [speaker names](SPEAKER_NAMES.md), [speaker identification](docs/SPEAKER_IDENTIFICATION.md) and [voice profiles](docs/VOICE_PROFILE.md).

## Devices

| Device | Recording | Additional hardware and controls |
| --- | --- | --- |
| ESP32-C3 SuperMini | Audio, playback, transcription and memory | External I2S mic, touch, battery telemetry, BLE standby and deep sleep |
| ESP32-S3 SuperMini / S3FH4R2 | Same audio workflow; longer recovery with PSRAM | External I2S mic, touch, battery monitoring, BLE standby and deep sleep |
| Chakshu / XIAO ESP32S3 Sense | Same audio workflow using onboard PDM | Phone-local photos and timestamped video with local soundtracks; existing SD imports |

`devices/catalog.json` mirrors the firmware catalog. Firmware reports supported capabilities and hardware readiness independently; the PWA also verifies protocol support, account association and connection ownership before enabling an action. Unknown devices cannot unlock Chakshu-only controls. See [device capabilities](docs/DEVICE_CAPABILITIES.md).

## Chakshu

A Chakshu associated with the signed-in account unlocks its photo/video library. Header camera and video controls open the capture preview. New photos, video frames and their soundtracks stay on the current phone/browser, including when an SD card is inserted; no cloud image processing or soundtrack transcription is implied by capture. Existing SD files can still be imported or downloaded locally. S3/C3 expose audio controls without unsupported camera controls. See [Chakshu capture and playback](docs/CHAKSHU.md).

## AI, storage and endpoints

Settings → **Memory** configures Synap Cloud or a compatible custom endpoint for standalone audio processing. Custom endpoint authentication failures are surfaced separately from Synap Cloud routing so a bad custom configuration does not silently fall through to the wrong service.

Original audio is preserved; optional enhancement creates a separate copy. Local browser data remains device/browser scoped, so export local originals before clearing site data. Settings also exposes pendant, browser-storage, offline-app and network health information. See [memory workspace](docs/MEMORY_WORKSPACE.md), [memory and audio](docs/MEMORY_AND_AUDIO.md), [backend/custom endpoint contract](docs/BACKEND_AI_STT_ENDPOINT_SPEC.md) and [encryption](docs/ENCRYPTION.md).

## Firmware updates

Settings → **Firmware** reads the permanent device ID and target and selects the corresponding production manifest. Target, build, image structure, size and SHA-256 checks remain mandatory. The published firmware feed—not a source commit by itself—determines the latest installable build. First installation is performed over USB; routine compatible updates use BLE OTA.

## Development

Use Node.js 22 or later:

```sh
npm ci
npm ci --prefix backend
npx playwright install chromium
npm run dev
```

Open `http://localhost:4173`. Before publishing, run `npm test`, `npm run typecheck`, `npm run test:backend` and `npm run test:browser`. Browser fixtures exercise the application flows, but real Bluetooth throughput, microphone quality, camera behavior and device power characteristics still require physical hardware validation. See [Contributing](CONTRIBUTING.md) for focused suites, formatting, catalog synchronization and release checks.

## Guides

- [Architecture and source ownership](docs/ARCHITECTURE.md), [device capabilities](docs/DEVICE_CAPABILITIES.md)
- [Audio pipeline and diagnostics](docs/AUDIO_PIPELINE.md), [recording lifecycle](docs/RECORDING_LIFECYCLE.md)
- [Memory workspace](docs/MEMORY_WORKSPACE.md), [memory and audio](docs/MEMORY_AND_AUDIO.md)
- [My actions](docs/MY_ACTIONS.md), [meeting features](docs/MEETING_FEATURES.md)
- [Settings and navigation](docs/SETTINGS_AND_NAVIGATION.md)
- [Speaker names](SPEAKER_NAMES.md), [speaker identification](docs/SPEAKER_IDENTIFICATION.md), [voice profiles](docs/VOICE_PROFILE.md)
- [Chakshu](docs/CHAKSHU.md), [recording notifications](docs/RECORDING_NOTIFICATIONS.md)
- [Authentication compatibility](docs/auth-compatibility.md), [encryption](docs/ENCRYPTION.md)
- [GCP deployment](docs/GCP_DEPLOYMENT.md), [GitHub deployment](docs/GITHUB_DEPLOY.md)
- [Backend/custom endpoint contract](docs/BACKEND_AI_STT_ENDPOINT_SPEC.md)
