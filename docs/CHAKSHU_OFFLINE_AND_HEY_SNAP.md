# Chakshu — offline operations and Hey Snap

**Baseline:** PWA `main`, firmware build **1351**, voice protocol **2**, media protocol **1**.
**Device:** `xiao-esp32s3-sense-8m` (XIAO ESP32-S3 Sense, 8 MB), module id `3`, OTA marker `SYNAP-CHAKSHU-OTA-ID-V3`, advertising name `synap-Chakshu`.

This document covers what Chakshu does when nobody is holding its Bluetooth link, and how that hands over cleanly when the app connects. For the C3 and S3 pendants see `README.md`; neither has a camera, an SD card or a wake engine.

---

## 1. The ownership rule

**Hey Snap runs only while Chakshu is *not* connected to the PWA over BLE.**

At any moment exactly one side owns the pendant's commands and operations:

| State | Owner | What issues commands | Where captures land |
| --- | --- | --- | --- |
| Disconnected from the app | Firmware | The Hey Snap wake engine | SD card |
| Connected to the app | PWA | The app's media transport | SD card, or straight to the phone |

On connect, the app writes the voice-disable opcode once, confirms the device reports itself disabled, and then stops touching the voice characteristics entirely. On disconnect the wake engine comes back and Chakshu is a standalone recorder again.

### Why

Before this rule both sides were live at once. The app polled the voice control and diagnostics characteristics every 1.9 seconds through the same serialized media queue that carries audio, while the firmware kept listening for a wake word that could start an SD capture underneath it. Build 1351 logs show where that ends:

```
GATT operation failed  { operation: "Read Chakshu voice diagnostics", name: "TimeoutError" }
Audio delivery stalled; retrying notifications and buffered audio
GATT disconnected      { origin: "browser-or-peripheral" }
```

with the SD card never mounting across the session (`sdMountAttempts` climbing 5 → 9) and the readiness mask dropping from `911` to `651`. That difference is exactly two bits — `sd` (4) and `sdAudio` (256) — which is why a spoken "Record a video" came back as **Could not start**: video records to SD, and SD was gone.

Two owners on one pendant is the root cause. One owner at a time is the fix.

### Implementation

`devices/chakshu/voice.js`:

- **Control opcodes** (`0xcc`, protocol byte, opcode), a separate number space from command ids:
  `0` disable wake engine · `1` enable wake engine.
  (`2` and `3` were foreground/background leases. The app no longer takes either.)
- `sync()` — writes `0`, reads the status characteristic once to confirm `enabled === false`, then stops. No notification subscription, no status poll, no diagnostics read. A stood-down device is never read again.
- Retries — three attempts, five seconds apart, for a device that answers and stays enabled. A request deferred behind capture or recovery (`OPTIONAL_GATT_DEFERRED`) never reached the device, so it does not spend that budget; it re-checks every 15 seconds, and while the media queue is closed no GATT request is issued at all.
- `release()` — writes `1` before an app-initiated disconnect, called from `disconnectGatt()` in `app.js`.
- `diagnose()` — one-shot classifier read, on request only. Never on a timer.
- `enabled(true)` is refused while connected. Enabling the wake engine over a live link is precisely the state this rule exists to prevent.

### Firmware requirement

`release()` is **best effort and cannot be otherwise.** An unexpected disconnect — out of range, flat battery, a dropped GATT link — gives the app no chance to write anything.

> **Firmware must re-arm the wake engine whenever the BLE link drops.**

Until it does, Hey Snap stays off after an unclean disconnect until the next connect/disconnect cycle. This is the one open item in the handover.

---

## 2. Hey Snap

### Protocol

Service characteristics (`devices/chakshu/voice.js`):

| Characteristic | UUID | Use |
| --- | --- | --- |
| Control | `4fa12356-…` | Write opcodes, read 22-byte status |
| Events | `4fa12357-…` | Command notifications (no longer subscribed by the app) |
| Diagnostics | `4fa12358-…` | 20-byte classifier/microphone frame, read on demand |

### Commands

| Id | Phrase | Effect |
| --- | --- | --- |
| 1 | **Hey Snap** | Wake; listen for a command |
| 2 | Take a snap | Photo to SD |
| 3 | Record a video | Video to SD |
| 4 | Stop video | End the clip |
| 5 | Start audio | Audio to SD |
| 6 | Stop audio | End the take |
| 7 | What do you see | Vision capture |
| 8 | Stop | Cancel the current operation |

### Status frame — 22 bytes, `0xcd`

| Offset | Field |
| --- | --- |
| 0–1 | `0xcd`, protocol (`2`) |
| 2 | status (0–5) |
| 3 | wake engine enabled |
| 4–7 | sequence (u32 LE) |
| 8 | last command |
| 9 | result (0–3; `1` = could not start, `3` = saved to SD) |
| 10–13 | timestamp ms |
| 14–17 | dropped frames |
| 18 | offline capture active |
| 20–21 | value |

### Diagnostic frame — 20 bytes, `0xce`

Mean absolute level, peak, candidate command, confidence (per mille), candidate timestamp, candidate count, active flag. A healthy build 1351 device reports `candidateLabel: "Hey Snap", confidencePercent: 100`.

Read it with `SynapChakshuVoice.diagnose()`; the result is dispatched as `synap-voice-diagnostic` and appears in the app's diagnostic log as `Voice setup`.

### What the app no longer does

Wake feedback in the header (`Hey Snap · Listening…`, `Saved on Chakshu · Take a snap`) existed to narrate commands spoken over a live link. There are none now, so it stays hidden. Captures made offline surface in the Library through the SD sweep described below, not through a live event.

---

## 3. Offline operations

Chakshu records to its SD card with no phone, no network and no app.

### Capability gate

Every offline capture requires the readiness bits for its media type **and** for storage. From `devices/capabilities.js`:

```js
canCapture(info, kind, offline) =
  hasMedia(info) && ready(info, 'camera') && ready(info, kind) &&
  (kind !== 'video' || ready(info, 'audio')) &&
  (!offline || (ready(info, 'sd') && (kind !== 'video' || ready(info, 'sdAudio'))))
```

Readiness bitmask (`devices/catalog.json`):

| Bit | 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Feature | audio | camera | sd | settings | touch | battery | standby | video | sdAudio | photo |

A healthy Chakshu reports `supported: 911` = `photo | sdAudio | video | settings | sd | camera | audio`. It has no touch pad, battery sensor or standby.

### Capture

| Operation | Transport op | Notes |
| --- | --- | --- |
| Start offline video | `5`, arg `profile \| (seconds << 8)` | Clip length **15, 30 or 60 s** only; profile `0` = 1280×720 @10 fps, `1` = 640×480 @20 fps |
| Stop | `6` | |
| Offline status | `9` | JSON: `active`, `error`, progress; polled every 2 s while active |
| Refresh SD status | `14` | Free/total MiB, mount state |
| Delete a path | `17` | Used only after a verified import |
| Wi-Fi transfer | `20` start · `21` status · `22` stop | Bulk offload over Wi-Fi instead of BLE |

`error === 9` means the card could not keep up; the partial recording is kept rather than discarded.

> **Known inconsistency.** `devices/chakshu/capture-preview.js` declares `startOffline(profile = 0, seconds = 10)`, but `media.js` rejects anything outside `[15, 30, 60]`. The default is unreachable in practice because the UI passes the `visualSDLength` selection, but a call with no arguments throws *"Choose an available SD quality and clip length."* Worth aligning.

### Recovery back into the app

When the app reconnects, `devices/chakshu/media.js` sweeps SD on every connection change (`schedulePendingSync(1200)` on `synap-module-changed`) and lists what it finds. Nothing is deleted implicitly:

1. `syncPendingSD()` catalogues what is on the card. It never imports and never deletes.
2. SD-only items appear in the shared Library marked `sdOnly` with a **Move to app** action.
3. `moveSD(path)` imports, verifies, and only then calls `deleteSyncedSet(path)` — which removes the sidecar `.json` and `.wav` before the media file itself, so a half-deleted set is never left behind.
4. If verification fails: *"The capture was not verified in the app. The SD original was kept."*

Imported offline audio enters the normal transcription and memory pipeline like any other recording.

### Self-tests

Settings → Device runs firmware self-checks over a separate command channel (`devices/modules.js`, operations 1–4 — a different number space from the voice commands above):

| Op | Check | Requires |
| --- | --- | --- |
| 1 | Hardware check | — |
| 2 | Save photo | photo, camera, sd |
| 3 | 10-second WAV to SD | sdAudio, audio, sd |
| 4 | Silent camera clip | video, camera, sd |

---

## 4. Diagnosing the build 1351 failure signature

If the symptoms return, read them in this order:

1. **`ready` vs `supported`.** A drop from `911` means readiness was lost mid-session. Subtract to find which bits: `911 - 651 = 260 = sd + sdAudio`.
2. **`sdMountStage` / `sdMountAttempts`.** Repeated attempts at `mount` with `sdReady: false` mean the card never came up during the session — not that it is absent.
3. **`GATT operation failed`.** The `operation` field names the request that timed out. Anything on the media queue that times out stalls audio behind it.
4. **`Audio delivery stalled`** following a GATT timeout is the consequence, not the cause. Look at the operation above it.

A spoken command answering **Could not start** is the readiness gate doing its job: the capture needed a bit that was no longer ready.

---

## 5. Files

| Path | Role |
| --- | --- |
| `devices/chakshu/voice.js` | Wake engine ownership, protocol decode, `diagnose()` |
| `devices/chakshu/media.js` | Capture, SD catalogue, import, verified move, Wi-Fi transfer |
| `devices/chakshu/transfer.js` | Versioned request/response transport on the app-owned queue |
| `devices/chakshu/library.js` | SD-only Library entries and **Move to app** |
| `devices/capabilities.js` | Capability and readiness gates |
| `devices/catalog.json` | Device catalogue — the source of truth for flags and profiles |
| `tests/chakshu-voice.cjs` | Ownership rule and protocol decode |
| `tests/chakshu-media.cjs` | SD discovery, verified move, delete ordering |

Firmware lives in `DivyanKavdia/synap-firmware` and is not part of this repository.
