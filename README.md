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
| Idle or recording | Hold ~5 s | Enter deep sleep; active recording stops first |
| BLE standby | Double tap | Wake and start recording |
| Deep sleep | Hold continuously ~5 s | Wake and remain awake |
| Deep sleep | Release before ~5 s | Return immediately to deep sleep |

For compatible firmware, the PWA also places an idle connected pendant into BLE standby after about 30 seconds. BLE stays connected while the microphone/I2S and status LED are off.

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

Incoming packets are journaled to IndexedDB before a recording is sealed. The PWA:

- batches packet writes;
- preserves sequence gaps as silence so timing remains correct;
- compacts roughly 30-second windows into PCM;
- recovers unsealed recordings from committed packet data;
- rolls very long captures into safe parts while keeping them grouped as one continuous session;
- supports playback and WAV export/share.

Persistent browser storage is requested when available. Clearing site data can remove local recordings that have not been preserved elsewhere.

## Device identity and reconnect

Each pendant exposes a permanent `SYNAP-XXXXXXXXXXXX` identity derived by firmware. The PWA maps browser Bluetooth handles to that identity after a successful connection.

Where supported, `navigator.bluetooth.getDevices()` restores previously authorized devices without reopening the chooser. Manual disconnect disables automatic reconnect for the current page session.

## Firmware OTA

Routine firmware updates are one-click BLE OTA. Users do not need USB, a boot-button sequence, a binary picker or an OTA key.

The PWA:

1. reads the connected pendant identity, target and build;
2. fetches the target-specific production manifest;
3. validates target, build, size, SHA-256, URL and ESP image constraints;
4. transfers the binary over BLE;
5. resumes a live OTA session after a short reconnect when possible;
6. waits for firmware commit and reboot.

The signed production feed is authoritative for the latest firmware build. A Git commit alone is not a firmware release.

## Memory and AI

Settings → **Memory & AI** supports two processing modes.

### synap cloud

The managed backend in `backend/` handles authentication, encrypted memory storage and AI processing.

Pipeline:

`audio → transcript → conversations → people / decisions / actions / follow-ups → daily brief → retrieval → grounded answer`

Current capabilities include:

- rolling transcription during long recordings;
- speaker diarization and optional owner voice profile;
- people extraction with user confirmation/rename;
- daily briefs and memory views;
- local search across names, notes, summaries and transcripts;
- grounded Ask Synap retrieval;
- cloud history restore onto another signed-in device.

Local recording data always wins during cloud history restoration. Cloud-restored memories do not claim playable audio when the original audio is no longer available.

Security and deployment details are maintained in:

- `docs/ENCRYPTION.md`
- `docs/GCP_DEPLOYMENT.md`
- `docs/BACKEND_AI_STT_ENDPOINT_SPEC.md`
- `docs/VOICE_PROFILE.md`

### Custom endpoints

Users can instead configure HTTPS transcription and LLM endpoints. The local processing queue remains responsible for ordering, idempotency, retry and failure isolation.

## Diagnostics

Settings → **Diagnostics / System status** exposes relevant field data including:

- device identity and connection state;
- firmware build/target when available;
- GATT disconnect/reconnect events;
- reset reason;
- capture, notification and control drop counts;
- free/minimum heap and uptime;
- battery state;
- browser storage and persistence;
- network and service-worker state.

For recording interruptions, first determine whether a real GATT disconnect occurred. Browser suspension without a disconnect is handled differently from a physical BLE link loss.

## PWA updates

The service worker caches the application shell for offline startup. App reload/update actions must not interrupt recording, saving or firmware OTA. IndexedDB recording data is not cleared by normal service-worker updates.

## Tests

Run browser-side regressions with:

```bash
node --test tests/*.cjs
```

Before a production release, validate at minimum:

- BLE connect/reconnect;
- real-microphone recording;
- touch start/stop/standby/deep-sleep behavior;
- 5-second hold wake from deep sleep;
- long-recording rollover;
- screen-lock/foreground recovery;
- battery telemetry;
- OTA update/resume/reboot;
- post-update reconnect;
- local storage recovery and cloud processing.