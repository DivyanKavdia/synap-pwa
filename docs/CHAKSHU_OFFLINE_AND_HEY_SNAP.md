# Chakshu — single-owner capture, offline SD and Hey Snap

**Target contract:** PWA shell `1.0.0-shell156-offline-cue`, Chakshu voice asset `1.0.0-chakshu-voice12`, voice protocol **2**, media protocol **1**.  
**Production PWA:** deployed from current `main` through GitHub Pages.  
**Production firmware:** Synap OS build **1396** (`synap-os1-build1396`), source `dc6a170ca12cb2491e38a43f0df8b15e3a6f568d`; OTA artifacts are target-bound and the release workflow verifies digests, GitHub provenance and browser CORS.  
**Device:** `xiao-esp32s3-sense-8m`, module id `3`, OTA marker `SYNAP-CHAKSHU-OTA-ID-V3`, advertising name `synap-Chakshu`.

This is the operational contract for Chakshu. Odyssey C3/S3 do not have a camera, SD card or local wake engine.

## Current production state

The single-owner architecture is now the production baseline, not a pending candidate:

- BLE connected → PWA owns commands and direct-to-app capture.
- BLE disconnected → firmware owns Hey Snap and writes standalone captures to SD.
- Firmware re-arms Hey Snap on every BLE disconnect.
- Firmware build 1396 retains the 10 → 4 → 1 MHz SD cold-detection ladder, sticky 1 MHz post-mount I/O recovery and the SD ownership/invariant guards added before the voice-model rollout.
- Shell156 keeps the offline-result cue visible in the SD inbox and suppresses repeated catalogue probes when firmware already reports no SD card; Chakshu voice asset voice12 adds explicit reconnect cues for offline audio and describe captures.
- Offline SD items remain non-destructive until a digest/byte-verified sync completes.

Physical device acceptance is still required; CI/release success proves software/release integrity, not card/contact/power quality on a particular Chakshu unit.

---

## 1. One owner, always

Chakshu has exactly one command/capture owner at a time.

| BLE state | Owner | Command source | New capture destination |
| --- | --- | --- | --- |
| **Disconnected from PWA** | Firmware | Local **Hey Snap** runtime | Chakshu SD |
| **Connected to PWA** | PWA | App controls | PWA/browser storage |

There is no supported state in which Hey Snap and the PWA both issue capture commands.

### BLE connect

Firmware treats the physical BLE link as the ownership boundary; it does not rely only on a later app write.

1. BLE connects.
2. Firmware immediately stands the local wake engine down.
3. The PWA writes voice opcode `0` as an idempotent ownership confirmation and reads status once.
4. The PWA does not subscribe to voice command events or poll voice diagnostics.
5. Audio, photo and video controls are app-owned and save directly into the PWA.
6. BLE clients cannot start the firmware SD-audio or SD-video recording operations.

The old voice `0/1` writes are now **session handoff signals**, not a persisted “voice enabled” preference.

### BLE disconnect

Firmware re-arms standalone voice on **every** disconnect, including:

- user/app initiated disconnect,
- browser/native BLE failure,
- out-of-range disconnect,
- an unexpected dropped GATT link.

The PWA still sends opcode `1` before a clean disconnect when it can, but correctness no longer depends on receiving it.

If an SD capture was already in progress when BLE connects, it is allowed to close its files cleanly rather than being corrupted mid-write. No new local voice command is admitted after connection.

---

## 2. SD is a required offline inbox

The SD card is not an optional “higher-quality recording mode” while connected. Its product role is persistent offline storage for standalone Chakshu.

### Boot

Chakshu attempts SD initialization during media startup, before BLE is fully available.

Cold boot and card re-detection use:

```text
SPI pins initialise once
    ↓
10 MHz
    ↓ if no mount
4 MHz
    ↓ if no mount
1 MHz
```

A mount is not declared ready until firmware can also:

- access/create `/synap`,
- open it as a directory,
- read non-zero card capacity.

A card that never mounted is **not** pinned to the last failed clock. A later catalogue / **Check SD card** operation repeats the full detection sequence.

After a card was mounted and then suffers a genuine I/O fault, recovery is deliberately different: firmware resets the SPI bus, retries at **1 MHz**, and keeps that conservative recovery clock for the rest of that boot.

Recovery never formats the card.

### PWA visibility

When Chakshu is connected, the PWA always surfaces SD state:

- **SD card ready** — offline inbox can be catalogued/synced.
- **SD card unavailable** — offline Hey Snap capture is not considered available; the UI offers **Check SD card**.
- When catalogue re-detection restores the card, firmware republishes the refreshed SD/SD-audio readiness so the next capability read can return the healthy mask.

For current Chakshu capabilities:

```text
supported = 911
healthy ready = 911
SD + SD-audio missing = 651
911 - 651 = 260 = sd(4) + sdAudio(256)
```

Failed SD media responses can include `sdReady`, `sdClockHz`, `sdMountStage`, `sdMountAttempts`, `sdRecoveryLocked` and `freeHeap`.

### Catalogue probing

While the readiness mask reports no card, **shell152** catalogues **once per connection** and then stops.

The single probe is kept because a catalogue is what makes firmware repeat detection. The repetition is not: an unmounted card answers `SD file unavailable` after about 4.6 seconds, and `synap-module-changed` re-arms the sweep roughly every 15, so a third of the shared media queue goes on re-asking a question the device already answered. That queue is also the audio transport.

The probe is forgotten, and a fresh one allowed, on:

- a GATT disconnect, since the card may be reseated or mount cleanly next boot,
- a different `deviceId`,
- an explicit **Check SD card**.

A successful catalogue is followed by a capability refresh, so a card that firmware re-detects clears the state on its own.

---

## 3. Capture behavior

### Connected to the PWA

All user capture is direct-to-app:

- **Audio** — the normal PWA recording/journal path.
- **Photo** — transferred from camera to the PWA and stored in the local visual library.
- **Video** — camera frames plus the app-owned audio journal are stored in the PWA.

The connected UI no longer offers **Record video on SD**. Firmware also rejects remote BLE requests for SD video/audio recording, protecting the contract from old cached clients.

SD remains accessible while connected for:

- health/capacity,
- catalogue,
- syncing offline captures,
- verified source deletion after sync,
- explicit Synap-capture cleanup,
- optional bulk Wi-Fi offload.

### Disconnected from the PWA

Firmware owns local capture. Supported standalone captures are written under `/synap/` and protected by the SD FIFO rules.

Build 1396 deploys the current **experimental 8-class personalized TinyML field model**:

| Learned phrase/class | Standalone action while BLE is disconnected |
| --- | --- |
| **Hey Snap** | Arm the short command window |
| **Take a snap / photo** | Full-resolution photo → SD |
| **Record a video** | 10-second default video + soundtrack → SD |
| **Record / start audio** | Bounded 60-second WAV → SD |
| **Explain / what do you see** | Capture a full-resolution photo → SD and mark the completion as Describe |
| **Stop** | Stop/cancel the active local operation |

The PWA reconnect path understands Audio and Describe completion results. Audio is shown as an offline SD recording and can be synced into the normal transcription/memory pipeline. Describe is intentionally surfaced as a **captured SD photo awaiting visual description**; the firmware does not pretend that cloud inference happened while disconnected. After the photo is synced, visual description can use the normal connected Gemini-backed path.

> **Model-quality observation for continuity:** the build 1396 model uses synthetic English augmentation plus 22 supplied 16 kHz mono utterances for record-audio, record-video and explain-what-you-see. Quantized synthetic held-out accuracy was 94.0% and fit on the available real utterances was 95.5%, but the limited independent real holdout was weak at roughly 30%. This release is therefore a field baseline, not a claim of production-grade recognition accuracy. The next training iteration must use more independently recorded, separated real-device utterances (including negatives/noise and command confusions) before recognition thresholds or production-accuracy claims are tightened.

---

## 4. Reconnect and unsynced-media workflow

Connection does **not** automatically delete or silently import SD data.

### Discovery

After module/connection identification:

1. `syncPendingSD()` catalogues the SD card.
2. Catalogue discovery is non-destructive.
3. Standalone `.jpg`, `.mjpeg` and standalone `.wav` files become **Not synced · On Chakshu SD** items.
4. The PWA shows the pending count and a **Sync offline captures** action.
5. Individual items also expose **Sync to app**.

A successful catalogue re-detection is followed by a capability refresh so SD status shown in the PWA follows firmware state.

### Verified sync

The current verified move path is intentionally transactional at the product level:

1. Download the SD source.
2. For video, also retrieve matching timeline JSON and WAV when present.
3. Import into the account-owned PWA store/journal.
4. Compute/compare the source digest and verify the durable app copy.
5. Only after verification, issue SD delete operation `17`.
6. Video companions are deleted before the primary MJPEG so an interrupted cleanup cannot expose the soundtrack as a new standalone item.
7. Refresh the catalogue.

If transfer or verification fails, the SD source is retained. **No failed sync loses the offline original.**

**Sync offline captures** processes the pending catalogue sequentially. Successfully verified items are removed from SD; failed items remain and can be retried.

### Audio after sync

A standalone offline PCM WAV is imported through the normal recording journal. It then enters the same transcription and memory pipeline as an app-recorded audio take.

---

## 5. SD storage ownership and cleanup

Only files matching Synap’s narrow generated capture pattern are managed:

```text
/synap/XXXXXXXX-XXXXXXXX.jpg
/synap/XXXXXXXX-XXXXXXXX.mjpeg
/synap/XXXXXXXX-XXXXXXXX.wav
/synap/XXXXXXXX-XXXXXXXX.json
```

Model files, user-copied files and unrelated card contents are outside FIFO / Clear SD ownership.

Unsynced SD captures are treated as user data and are **not automatically evicted** to make room for a new recording. If the required reserve cannot be met without deleting unsynced media, the new capture must fail safely and the existing SD inbox remains intact. An in-progress/protected capture is never selected for cleanup.

After a byte/digest-verified **Sync to app**, the corresponding SD source is deleted as part of the verified move. **Clear SD** remains an explicit user action that removes Synap capture files only; it is not a format operation.

---

## 6. Relevant operations and protocol surfaces

### Media transport

| Operation | Role under this contract |
| --- | --- |
| `1/2` etc. | Connected camera snapshot/transfer into PWA |
| `5` | Local-only SD video start; remote BLE client is rejected |
| `10` | Local-only SD audio start; remote BLE client is rejected |
| `6` | Stop current SD capture |
| `7` | Catalogue offline inbox |
| `14` | Re-check/remount SD and publish readiness |
| `17` | Delete a verified synced capture |
| `18` | Clear Synap-owned captures |
| `20/21/22` | Private Wi-Fi bulk download lifecycle |

### Voice control characteristic

`4fa12356-…` remains protocol v2:

- opcode `0`: stand local voice down for the BLE session,
- opcode `1`: release ownership back to standalone firmware.

Firmware BLE callbacks independently enforce the same state, so missing opcode `1` on an unclean disconnect no longer leaves Hey Snap disabled.

---

## 7. Acceptance criteria

Run these criteria on **firmware build 1396 + PWA shell156 + Chakshu voice12**. Do not call the feature physically complete until one Chakshu passes all of these:

1. Cold power-on with card inserted reports SD ready without opening the PWA.
2. Connect to PWA: Hey Snap produces no local command/action for the full connected period.
3. Connected PWA audio saves directly to the app; no new SD WAV is created.
4. Connected PWA photo saves directly to the app; no offline SD photo is created.
5. Connected PWA video saves directly to the app; no local SD-record command can be started over BLE.
6. Disconnect unexpectedly: Hey Snap re-arms without another connect/disconnect cycle.
7. Disconnected **Take a snap** creates a durable SD image.
8. Disconnected **Record a video** creates a durable SD video/soundtrack bundle.
9. Reconnect: all unsynced SD items are listed and pending count is correct.
10. Sync one item: app copy verifies, then SD original disappears.
11. Force a transfer/verification failure: original remains on SD.
12. Sync all: successful items clear from SD; failed items remain.
13. Disconnected **Record audio** creates a durable WAV on SD; reconnect surfaces an offline-audio result and, after sync, the WAV enters transcription/memory.
14. Disconnected **Explain / what do you see** creates a durable photo on SD; reconnect clearly says the photo still needs visual description rather than claiming offline Gemini inference.
15. Remove/reinsert or induce recoverable SD fault: **Check SD card** re-detects and PWA readiness updates.
16. After real post-mount I/O failure, diagnostics show conservative recovery rather than repeated fast-clock retries.
17. Collect a larger independent real-device command/negative set and retrain before treating the experimental 8-class model as production-accurate.

---

## 8. Source files

| Repository path | Responsibility |
| --- | --- |
| firmware: `firmware/xiao-sense/ble-server.cpp` | Physical BLE ownership handoff |
| firmware: `firmware/xiao-sense/voice.cpp` | Disconnected-only TinyML runtime |
| firmware: `firmware/xiao-sense/sd-storage.cpp` | Boot mount, recovery, FIFO, deletion |
| firmware: `firmware/xiao-sense/media-transfer.cpp` | Local SD jobs, catalogue and transfer |
| PWA: `devices/chakshu/voice.js` | Idempotent session stand-down/release |
| PWA: `devices/chakshu/media.js` | Connected capture, catalogue discovery/state |
| PWA: `devices/chakshu/capture-preview.js` | Digest-verified SD sync |
| PWA: `devices/chakshu/library.js` | Unsynced inbox + shared Library surface |
