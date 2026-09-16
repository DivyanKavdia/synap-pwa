# synap — PWA

**Stay present. Keep the memory.**

Synap receives pendant audio over Bluetooth, saves it locally, builds searchable memory and manages firmware updates. Chakshu adds a camera, a photo/video library. The browser is served directly from this repository; firmware lives in [synap-firmware](https://github.com/DivyanKavdia/synap-firmware).

## Devices

| Device                       | Recording                                       | Additional hardware and controls                                                    |
| ---------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| ESP32-C3 SuperMini           | Audio, playback, transcription and memory       | External I2S mic, touch, battery telemetry, BLE standby and deep sleep              |
| ESP32-S3 SuperMini / S3FH4R2 | Same audio workflow; longer recovery with PSRAM | External I2S mic, touch, battery monitoring, BLE standby and deep sleep             |
| Chakshu / XIAO ESP32S3 Sense | Same audio workflow using onboard PDM           | Phone-only photos and timestamped video with local soundtracks; existing SD imports |

`devices/catalog.json` mirrors the firmware catalog. Firmware reports supported features and hardware readiness independently; the PWA also checks protocol support, account association and connection ownership before an action. Unknown devices cannot unlock Chakshu controls. See [device capabilities](docs/DEVICE_CAPABILITIES.md).

## Use the app

Connect through the pendant picker and use the microphone button for audio. Recordings are journaled before processing and remain available for playback or WAV export. Compatible firmware can replay a short volatile buffer after a brief disconnect; it cannot preserve an unlimited background recording. On iPhone, keep Synap visible in Bluefy with the screen unlocked. See [recording lifecycle](docs/RECORDING_LIFECYCLE.md) and [background limits](docs/BACKGROUND_RECORDING.md).

A Chakshu associated with the signed-in account unlocks **Library → Photos & video**. Header camera/video buttons open a capture preview. New photos, video frames and their soundtracks stay on the current phone/browser, including when an SD card is inserted. No cloud image processing or soundtrack transcription runs. Existing SD files can still be imported or downloaded locally. S3/C3 show their audio controls without unsupported camera buttons. See [Chakshu capture and playback](docs/CHAKSHU.md).

Settings → **Memory** configures Synap cloud or custom endpoints for standalone audio. Recognition preserves the complete text before adding speaker annotations; readable window transcripts appear before the final summary. Summaries use grounded source evidence. Original audio is preserved; optional enhancement produces a separate copy. Export local originals before clearing site data. See [transcription quality and recovery](docs/TRANSCRIPTION_QUALITY.md).

Settings → **Firmware** reads the permanent device ID and target, then selects the corresponding production manifest. Target, build, image structure, size and SHA-256 checks remain mandatory. The published firmware feed determines the latest available build; a source commit alone is not a release. Routine updates use BLE OTA.

## Development

Use Node.js 22 or later:

```sh
npm ci
npm ci --prefix backend
npx playwright install chromium
npm run dev
```

Open `http://localhost:4173`. Run `npm test`, `npm run typecheck`, `npm run test:backend` and `npm run test:browser` before publishing. See [Contributing](CONTRIBUTING.md) for focused suites, formatting, catalog synchronization and release checks. Browser fixtures simulate the devices; actual radio, microphone, camera and power behavior require hardware validation.

## Guides

- [Architecture and source ownership](docs/ARCHITECTURE.md), [device capabilities](docs/DEVICE_CAPABILITIES.md)
- [Audio pipeline and diagnostics](docs/AUDIO_PIPELINE.md), [recording lifecycle](docs/RECORDING_LIFECYCLE.md)
- [Chakshu](docs/CHAKSHU.md), [recording notifications](docs/RECORDING_NOTIFICATIONS.md)
- [Memory workspace](docs/MEMORY_WORKSPACE.md), [memory and audio](docs/MEMORY_AND_AUDIO.md)
- [My actions](docs/MY_ACTIONS.md), [meeting features](docs/MEETING_FEATURES.md)
- [Settings and navigation](docs/SETTINGS_AND_NAVIGATION.md)
- [Speaker names](SPEAKER_NAMES.md), [speaker identification](docs/SPEAKER_IDENTIFICATION.md), [voice profiles](docs/VOICE_PROFILE.md)
- [Authentication compatibility](docs/auth-compatibility.md), [encryption](docs/ENCRYPTION.md)
- [GCP deployment](docs/GCP_DEPLOYMENT.md), [GitHub deployment](docs/GITHUB_DEPLOY.md)
- [Backend/custom endpoint contract](docs/BACKEND_AI_STT_ENDPOINT_SPEC.md)
