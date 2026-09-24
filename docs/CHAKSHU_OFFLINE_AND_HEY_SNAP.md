# Chakshu — parallel Hey Snap, PWA/TTP capture and SD sync

**Target contract:** PWA shell `1.0.0-shell165-parallel-voice` or later, Chakshu voice protocol **2**, media protocol **1**.  
**Device:** `xiao-esp32s3-sense-8m`, module id `3`, OTA marker `SYNAP-CHAKSHU-OTA-ID-V3`, advertising name `synap-Chakshu`.

This is the operational contract for Chakshu. Odyssey C3/S3 do not have the Chakshu camera/SD/local-wake stack.

## 1. Routing principle

**The initiator determines the destination. BLE connectivity does not.**

| Initiator | BLE state | Action | Destination |
| --- | --- | --- | --- |
| Hey Snap | Connected | Audio / photo / video / describe | Chakshu SD |
| Hey Snap | Disconnected | Audio / photo / video / describe | Chakshu SD |
| PWA | Connected | Audio / photo / video | BLE → PWA/browser storage on phone |
| TTP223 double tap | Connected | Audio start / stop | BLE → PWA/browser storage on phone |
| TTP223 double tap | Disconnected | Audio start / stop | Chakshu SD |
| TTP223 | Any | Photo / video | **Not supported** |

Hey Snap therefore remains armed through connect, reconnect and disconnect. The PWA no longer stands the local wake engine down when GATT connects.

The paths are logically parallel but shared camera, microphone, SD and OTA resources are still serialized. If one path already owns a conflicting resource, another request is rejected/busy rather than creating two writers.

A spoken **Stop** belongs only to the voice-owned SD session. It must never stop an audio/video session that was started by the PWA or by connected TTP.

## 2. Hey Snap

The embedded eight-class TinyML runtime recognizes:

| Phrase/class | Action |
| --- | --- |
| **Hey Snap** | Arm the short next-command window |
| **Take a snap / photo** | Full-resolution photo → SD |
| **Record a video** | Bounded video + soundtrack bundle → SD |
| **Record audio** | Bounded WAV → SD |
| **Explain what you see** | Tagged full-resolution photo → SD; description after verified sync |
| **Stop** | Stop/cancel the voice-owned local operation |

The wake phrase and command remain a two-step interaction. Firmware clears the wake inference history and requires fresh post-wake audio before accepting the action.

The current field model remains experimental; this routing change does not retrain or replace its weights.

### Connected behavior

When BLE is connected:

1. The PWA subscribes once to the dedicated voice-result characteristic.
2. It writes idempotent voice-on opcode `1` so an upgraded device cannot remain in an old stand-down state.
3. It does **not** poll voice status/diagnostics in the background.
4. Hey Snap media is still executed by firmware and stored on SD.
5. Completion/busy/error status can be surfaced in the PWA through the voice event characteristic.

Legacy opcode `0` no longer transfers ownership or disables Hey Snap on firmware carrying this contract.

## 3. PWA capture

PWA controls remain direct-to-phone:

- **Audio:** normal PWA recording/journal path.
- **Photo:** camera frame is transferred over BLE and stored in the PWA visual library.
- **Video:** camera frames plus the app-owned audio journal are stored in the PWA.

A connected BLE client cannot invoke the firmware's local SD-audio or SD-video start operations. This is the guard that prevents a PWA button from silently switching destination to SD.

The old connected **Record video on SD** concept remains unsupported.

## 4. TTP223

TTP223 is intentionally audio-only.

- **Connected double tap:** firmware emits the existing live START/STOP command path. The PWA adopts the hardware-started stream and stores audio on the phone.
- **Disconnected double tap:** firmware starts/stops local SD audio.
- **4-second hold:** existing sleep/wake behavior.
- **No tap sequence triggers a photo or video.**

This boundary is regression-tested in firmware.

## 5. SD lifecycle

SD remains durable device storage for Hey Snap captures and disconnected TTP audio.

Chakshu attempts SD initialization during media startup, independently of BLE. Recovery remains non-destructive and never formats the card. GPIO21 remains SD chip-select; its electrical sharing with the XIAO Sense orange USER_LED means SD transactions can visibly flash that LED even though Synap never uses it as a semantic status indicator.

When connected, the PWA can inspect the catalogue and surface unsynced `.jpg`, `.mjpeg` and standalone `.wav` items in Memories regardless of whether they were captured while BLE was connected or disconnected.

### Verified sync

Sync is transactional at the product level:

1. Download the SD source.
2. Download matching video JSON/WAV companions when present.
3. Persist into the account-owned PWA store/journal.
4. Verify size/digest against the source.
5. Only after durable verification, issue the SD delete operation.
6. Refresh the catalogue.

If transfer or verification fails, the SD original remains. Successfully verified items may be removed from SD; failed/unsynced captures must not be silently deleted.

Imported SD audio then enters the normal transcription/memory pipeline. A tagged **Explain what you see** image receives visual inference only after verified sync.

## 6. Media/voice protocol surfaces

| Operation / surface | Role |
| --- | --- |
| Media `1/2` etc. | Connected camera snapshot/transfer into PWA |
| Media `5` | Local-only SD video start; remote BLE request rejected |
| Media `10` | Local-only SD audio start; remote BLE request rejected |
| Media `6` | Stop current SD capture |
| Media `7` | Catalogue SD inbox |
| Media `14` | Re-check/remount SD and publish readiness |
| Media `17` | Delete verified synced source |
| Media `18` | Clear Synap-owned captures |
| Voice `4fa12356-…` | v2 control; opcode 1 is idempotent enable, old handoff semantics retired |
| Voice `4fa12357-…` | Result notification while connected |
| Voice `4fa12358-…` | Explicit diagnostics read; no background polling |

## 7. Acceptance matrix

Validate on the firmware release that contains the parallel-routing contract and PWA shell165 or later:

1. Cold boot with SD inserted reports storage ready without opening the PWA.
2. Disconnected: **Hey Snap → Take a snap** creates a durable SD image.
3. Disconnected: **Hey Snap → Record audio/video** creates SD media.
4. Connect to the PWA: Hey Snap remains responsive.
5. Connected: **Hey Snap → Take a snap** creates a new SD item, not a PWA photo.
6. Connected: **Hey Snap → Record audio/video** creates SD media, not a phone live capture.
7. Connected PWA audio creates a phone/PWA recording and no local SD-audio start.
8. Connected PWA photo creates a PWA visual item and no Hey Snap SD photo.
9. Connected PWA video creates the PWA video/audio take and no local SD-video start.
10. Connected TTP double tap starts/stops PWA audio and saves on phone.
11. Disconnected TTP double tap starts/stops SD audio.
12. No TTP gesture produces a photo or video.
13. Start a PWA recording, then issue Hey Snap media: conflicting local capture returns busy and does not corrupt/stop the PWA take.
14. Start voice SD capture, reconnect/disconnect: BLE transition alone does not invalidate the local request.
15. Spoken Stop never terminates a PWA/TTP live recording.
16. PWA catalogue shows unsynced SD items captured both online and offline.
17. Verified sync removes the SD original only after the PWA copy passes verification.
18. Force transfer/verification failure: SD original remains.
19. Remove/reinsert or induce a recoverable SD fault: **Check storage** re-detects the card and updates readiness.
20. Repeat voice-command tests across independent real sessions; recognition quality remains a separate physical acceptance criterion.

## 8. Source ownership

| Repository path | Responsibility |
| --- | --- |
| firmware: `firmware/xiao-sense/voice.cpp` | Always-on Hey Snap state, wake/command routing, voice results |
| firmware: `firmware/xiao-sense/ble-server.cpp` | BLE lifecycle without voice ownership transfer |
| firmware: `firmware/xiao-sense/media-transfer.cpp` | Local SD jobs, resource admission, catalogue/transfer |
| firmware: `firmware/shared/power.cpp` + Chakshu target patch | TTP connected live-audio and disconnected SD-audio routing |
| PWA: `devices/chakshu/voice.js` | Voice-result subscription and connected status surface |
| PWA: `devices/chakshu/media.js` | Phone-owned PWA capture and SD catalogue state |
| PWA: `recording-bridge.js` | Adoption of connected hardware/TTP live audio |
| PWA: `devices/chakshu/capture-preview.js` | Digest-verified SD sync |
| PWA: `devices/chakshu/library.js` | Unsynced SD inbox and Memories surface |

Physical acceptance remains required. CI validates code, protocol and release integrity; it cannot prove microphone recognition quality, SD-card/contact quality or power stability on an individual unit.
