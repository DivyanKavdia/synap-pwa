# synap — PWA

**Stay present. Keep the memory.**

Synap is a browser-based companion for the Synap pendant. It receives live audio over BLE, stores recordings locally, builds searchable memory, and manages pendant firmware updates.

[Audio capture, transport and cloud audit](docs/AUDIO_PIPELINE_AUDIT.md) documents the source-preserving audio path and its hardware limits.

## Product contract

- Product version: **1.0.0**
- Primary pendant: ESP32-S3 SuperMini / ESP32-S3FH4R2
- Secondary target: ESP32-C3 SuperMini
- Third module: **Chakshu / XIAO ESP32S3 Sense** — onboard mic, camera and SD checks ([guide](docs/CHAKSHU.md))
- Control protocol: **v2**
- Audio transport: **v2 uncompressed PCM16 preferred; v3 ADPCM fallback for small Bluetooth MTUs**
- OTA protocol: **v3**
- Production firmware feed: `DivyanKavdia/synap-firmware` → `ota-releases/latest.json`

The browser owns the durable packet journal, audio, recording metadata, processing state and local memory cache. Compatible firmware can retain a short, volatile audio buffer for an explicitly negotiated reconnect; it does not write audio to flash.

With a compatible pendant, the same open app page can recover buffered audio after a short disconnect. Capacity is reported by the firmware: up to 30 seconds on S3 PSRAM or 1.25 seconds with sufficient internal memory. Overflow, power loss, sleep or a closed/reloaded app can still lose audio. Screen Wake Lock and foreground recovery cannot override OS-level Bluetooth suspension.

On iPhone, keep Synap visible in Bluefy and the screen unlocked while recording. Switching to another app or locking the screen can suspend delivery of audio packets. The recording clock counts received audio; buffered replay can recover only the pendant's short retained window. This version uses the browser and requires no Apple developer account or Mac.

## Pendant interaction

Current ESP32-S3 and ESP32-C3 firmware share the same touch model:

| State | Gesture | Action |
| --- | --- | --- |
| Connected idle or BLE standby | Double tap | Start recording immediately on the second valid tap |
| Recording | Double tap | Stop recording and enter BLE standby |
| Idle, recording or BLE standby | Hold 4 seconds, then release | Enter deep sleep; active recording stops first |
| Deep sleep | Hold through 4-second boot validation, then release | Wake and continue normal boot |
| Awake | Single tap | No action |
| Deep sleep | Short touch | Return to deep sleep without starting BLE |

Wake validation starts after firmware boots, so allow a little extra time before
releasing. Wake alone does not start recording. Older S3 firmware uses triple tap
for sleep/wake; install the current firmware to use the shared gestures. The
[firmware target guide](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/HARDWARE_PINOUT.md)
contains wiring and timing details for both boards.

For compatible firmware, the PWA also places an idle connected pendant into BLE
standby after about 30 seconds.

## BLE service

Primary service: `4fa12345-0000-1000-8000-00805f9b34fb`

- audio: `4fa12346-0000-1000-8000-00805f9b34fb`
- control/status: `4fa12347-0000-1000-8000-00805f9b34fb`
- OTA write: `4fa12348-0000-1000-8000-00805f9b34fb`
- OTA status: `4fa12349-0000-1000-8000-00805f9b34fb`
- firmware identity: `4fa1234b-0000-1000-8000-00805f9b34fb`
- permanent device ID: `4fa1234c-0000-1000-8000-00805f9b34fb`
- diagnostics: `4fa1234d-0000-1000-8000-00805f9b34fb`
- asynchronous events: `4fa1234e-0000-1000-8000-00805f9b34fb`

Audio is captured at 16 kHz, mono. Firmware sends uncompressed PCM16 when the negotiated link supports it, with independent IMA ADPCM frames as a fallback for smaller MTUs. The PWA preserves PCM samples and decodes fallback frames without enhancement before storage and AI processing.

## Recording and storage

Incoming packets are journaled to IndexedDB before a recording is sealed. The PWA batches packet writes, preserves sequence gaps as silence, compacts processing windows, recovers unsealed recordings, retains legacy linked parts, and supports playback plus WAV export/share.

Startup recovery reuses existing processing jobs and preserves completed work. A recording that cannot recover is kept with a Retry notice while other recordings remain usable. Recording starts only after a storage write check succeeds; Connect, Change pendant and firmware updates use connection ownership independently of recording storage. Recovery retries target only the affected historical recordings.

Persistent browser storage is requested when available. Clearing site data can remove local recordings that have not been preserved elsewhere.

Settings → **Device → While listening → Recording notification** enables **Stop & save** and **Mark moment** in supported browser notifications after permission is granted. Notifications follow the confirmed take and close when it ends. They do not prevent background suspension. iOS Lock Screen recording controls and Dynamic Island require native Live Activities support; see [recording notifications and native requirements](docs/RECORDING_NOTIFICATIONS.md).

## Device identity and reconnect

Each pendant exposes a permanent `SYNAP-XXXXXXXXXXXX` identity derived by firmware. The PWA maps browser Bluetooth handles to that identity after a successful connection.

Where supported, `navigator.bluetooth.getDevices()` restores previously authorized devices without reopening the chooser. Manual disconnect disables automatic reconnect for the current page session.

## Firmware OTA

Routine firmware updates are one-click BLE OTA. Users do not need USB, a boot-button sequence, a binary picker or an OTA key.

The PWA reads the connected pendant identity, target and build; fetches the target-specific production manifest; validates target, build, size, SHA-256, URL and ESP image constraints; transfers the binary over BLE; resumes a live OTA session after a short reconnect when possible; and waits for firmware commit and reboot.

The signed production feed is authoritative for the latest firmware build. A Git commit alone is not a firmware release.

## Memory and AI

Settings → **Memory** supports Synap cloud and custom endpoint processing.

The managed backend pipeline is:

`audio → transcript → conversations → people / decisions / actions / follow-ups → daily brief → retrieval → grounded answer`

Current capabilities include rolling transcription, conservative silence handling, speaker diarization, optional owner voice profile, consented named voices with additional confirmed samples, people confirmation/rename, daily briefs, local search, grounded Ask Synap retrieval and cloud history restore.

Today and Weekly review share one card with source-linked memories in each view. Actions includes an independent timeline, Complete and Reopen. People profiles can be deleted while keeping recordings. See [memory workspace](docs/MEMORY_WORKSPACE.md) and [My actions](docs/MY_ACTIONS.md).

New summaries include topic chapters, grounded reminder suggestions and unanswered questions. Library recording details link those items to their source times. People → Prepare shows recent related conversations, open actions and questions inside My actions. Original recordings and upload samples are retained without automatic enhancement. See [meeting features](docs/MEETING_FEATURES.md) for usage and limits.

Local recording data always wins during cloud history restoration. Cloud-restored memories do not claim playable audio when the original audio is no longer available.

Security and deployment details are maintained in `docs/ENCRYPTION.md`, `docs/GCP_DEPLOYMENT.md`, `docs/BACKEND_AI_STT_ENDPOINT_SPEC.md` and `docs/VOICE_PROFILE.md`.

## Diagnostics

Settings → **Diagnostics / System status** exposes device identity, connection state, firmware target/build, GATT events, reset reason, capture/drop counts, memory, uptime, battery, storage, network and service-worker state.

For recording interruptions, first determine whether a real GATT disconnect occurred. Browser suspension without a disconnect is handled differently from a physical BLE link loss.

## PWA updates

The service worker caches the application shell for offline startup. App reload/update actions must not interrupt recording, saving or firmware OTA. IndexedDB recording data is not cleared by normal service-worker updates.

## Development and documentation

Start with [Contributing](CONTRIBUTING.md) for local setup, formatting, tests and
release checks. The [architecture map](docs/ARCHITECTURE.md) identifies each
module's owner and the remaining maintenance work.

- [Recording lifecycle and reconnect limits](docs/RECORDING_LIFECYCLE.md)
- [Memory, source editing, merges and audio](docs/MEMORY_AND_AUDIO.md)
- [Settings and navigation](docs/SETTINGS_AND_NAVIGATION.md)
- [My actions](docs/MY_ACTIONS.md) and [meeting features](docs/MEETING_FEATURES.md)
- [Recording notifications and native iOS requirements](docs/RECORDING_NOTIFICATIONS.md)
- [Speaker names](SPEAKER_NAMES.md), [speaker identification](docs/SPEAKER_IDENTIFICATION.md) and [voice profiles](docs/VOICE_PROFILE.md)
- [Authentication compatibility](docs/auth-compatibility.md)
- [Encryption](docs/ENCRYPTION.md), [GCP deployment](docs/GCP_DEPLOYMENT.md) and [GitHub deployment](docs/GITHUB_DEPLOY.md)
- [Backend/custom endpoint contract](docs/BACKEND_AI_STT_ENDPOINT_SPEC.md)

```sh
npm ci
npm ci --prefix backend
npm test
npm run test:backend
npx playwright install chromium
npm run test:browser
```

Browser fixtures cover simulated BLE, recovery, OTA, notifications and memory
workflows. Physical recording, gestures, RF interruptions, OS notification
controls, wake/sleep and firmware transfer still require device validation.

The [recording architecture audit](docs/RECORDING_AUDIT.md) documents the Bluetooth,
recording/storage and cloud-processing boundaries, confirmed fixes, and remaining
firmware/UI maintenance work.
