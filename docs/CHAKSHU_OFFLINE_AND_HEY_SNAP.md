# Chakshu — single-owner capture, offline SD and Hey Snap

**Target contract:** PWA shell `1.0.0-shell151-single-owner-sd-sync`, voice protocol **2**, media protocol **1**.  
**Firmware field reference:** build **1351**; the companion firmware candidate contains additional SD boot/recovery and BLE-ownership fixes.  
**Device:** `xiao-esp32s3-sense-8m`, module id `3`, OTA marker `SYNAP-CHAKSHU-OTA-ID-V3`, advertising name `synap-Chakshu`.

This is the operational contract for Chakshu. Odyssey C3/S3 do not have a camera, SD card or local wake engine.

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

The current personalized TinyML model has learned classes for:

| Learned phrase/class | Action |
| --- | --- |
| **Hey Snap** | Arm the short command window |
| **Take a snap / photo** | Photo → SD |
| **Record a video** | Video + soundtrack → SD |
| **Stop** | Stop/cancel current local operation |

The media protocol and SD recorder also support standalone WAV audio, and standalone `.wav` files are fully supported by the reconnect/sync pipeline.

> **Current model gap:** the deployed personalized TinyML weights do not yet contain a dedicated **Start audio** learned class. Therefore the data path for offline audio is complete, but a spoken “Hey Snap, start/record audio” command must not be claimed as production-ready until the personalized model is retrained with real Chakshu microphone examples for that class. Replacing the real-mic model with a synthetic-only model would regress the recognition work already completed.

Generic **Stop** already covers stopping an active local operation.

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

When reserve space is required, FIFO can remove the oldest unprotected Synap capture bundle. An in-progress/protected capture is never selected for cleanup.

**Clear SD** removes Synap capture files only; it is not a format operation.

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

Do not call the feature physically complete until one Chakshu passes all of these:

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
13. A standalone offline WAV appears as unsynced audio and, after sync, enters transcription/memory.
14. Remove/reinsert or induce recoverable SD fault: **Check SD card** re-detects and PWA readiness updates.
15. After real post-mount I/O failure, diagnostics show conservative recovery rather than repeated fast-clock retries.
16. After retraining the personalized voice model, **Start audio** recognition must be physically accepted before that spoken command is enabled as a production claim.

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
