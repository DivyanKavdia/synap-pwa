# synap — PWA

**Stay present. Keep the memory.**

Synap is a browser-based companion for the Synap pendant. It receives live audio over BLE, stores recordings locally, builds searchable memory, and manages pendant firmware updates.

## Product contract

- Product version: **1.0.0**
- Primary pendant: ESP32-S3 SuperMini / ESP32-S3FH4R2
- Secondary target: ESP32-C3 SuperMini
- Control protocol: **v2**
- Audio transport: **v3**
- OTA protocol: **v3**
- Production firmware feed: `DivyanKavdia/synap-firmware` → `ota-releases/latest.json`

The pendant is stateless for recordings. It captures audio and streams it to the PWA; it does not keep a local recording copy. The browser owns the packet journal, audio, recording metadata, processing state and local memory cache.

If Web Bluetooth disconnects, audio from the disconnected interval cannot be recovered. Screen Wake Lock and foreground recovery improve reliability but cannot override OS-level Bluetooth suspension.

## Pendant interaction

Production firmware uses the following touch model:

| State | Gesture | Action |
| --- | --- | --- |
| Connected idle | Double tap | Start recording |
| Recording | Double tap | Stop recording and enter BLE standby |
| Idle, recording or BLE standby | Triple tap | Enter deep sleep; active recording stops first |
| BLE standby | Double tap | Wake and start recording |
| Deep sleep | Triple tap | Wake and continue normal boot |
| Deep sleep | One or two taps | Return to deep sleep without starting BLE |

Double-tap Start/Stop is confirmed after a short wait for a possible third tap. This reserves triple tap as the power gesture in both directions.

The first touch electrically wakes the pendant from deep sleep, but BLE stays off until the complete triple-tap sequence is validated. For compatible firmware, the PWA also places an idle connected pendant into BLE standby after about 30 seconds.

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

Audio is captured at 16 kHz, mono. Firmware transports independent IMA ADPCM frames; the PWA decodes them back to PCM before storage and AI processing.

## Recording and storage

Incoming packets are journaled to IndexedDB before a recording is sealed. The PWA batches packet writes, preserves sequence gaps as silence, compacts processing windows, recovers unsealed recordings, rolls long captures into linked parts, and supports playback plus WAV export/share.

Persistent browser storage is requested when available. Clearing site data can remove local recordings that have not been preserved elsewhere.

## Device identity and reconnect

Each pendant exposes a permanent `SYNAP-XXXXXXXXXXXX` identity derived by firmware. The PWA maps browser Bluetooth handles to that identity after a successful connection.

Where supported, `navigator.bluetooth.getDevices()` restores previously authorized devices without reopening the chooser. Manual disconnect disables automatic reconnect for the current page session.

## Firmware OTA

Routine firmware updates are one-click BLE OTA. Users do not need USB, a boot-button sequence, a binary picker or an OTA key.

The PWA reads the connected pendant identity, target and build; fetches the target-specific production manifest; validates target, build, size, SHA-256, URL and ESP image constraints; transfers the binary over BLE; resumes a live OTA session after a short reconnect when possible; and waits for firmware commit and reboot.

The signed production feed is authoritative for the latest firmware build. A Git commit alone is not a firmware release.

## Memory and AI

Settings → **Memory & AI** supports Synap cloud and custom endpoint processing.

The managed backend pipeline is:

`audio → transcript → conversations → people / decisions / actions / follow-ups → daily brief → retrieval → grounded answer`

Current capabilities include rolling transcription, speaker diarization, optional owner voice profile, people confirmation/rename, daily briefs, local search, grounded Ask Synap retrieval and cloud history restore.

Local recording data always wins during cloud history restoration. Cloud-restored memories do not claim playable audio when the original audio is no longer available.

Security and deployment details are maintained in `docs/ENCRYPTION.md`, `docs/GCP_DEPLOYMENT.md`, `docs/BACKEND_AI_STT_ENDPOINT_SPEC.md` and `docs/VOICE_PROFILE.md`.

## Diagnostics

Settings → **Diagnostics / System status** exposes device identity, connection state, firmware target/build, GATT events, reset reason, capture/drop counts, memory, uptime, battery, storage, network and service-worker state.

For recording interruptions, first determine whether a real GATT disconnect occurred. Browser suspension without a disconnect is handled differently from a physical BLE link loss.

## PWA updates

The service worker caches the application shell for offline startup. App reload/update actions must not interrupt recording, saving or firmware OTA. IndexedDB recording data is not cleared by normal service-worker updates.

## Tests

Run browser-side regressions with:

```bash
node --test tests/*.cjs
```

Before production release, validate BLE connect/reconnect, real-microphone recording, double-tap start/stop, triple-tap deep sleep/wake, wake without premature BLE reconnect, long-recording rollover, foreground recovery, battery telemetry, OTA update/resume/reboot, post-update reconnect, storage recovery and cloud processing.
