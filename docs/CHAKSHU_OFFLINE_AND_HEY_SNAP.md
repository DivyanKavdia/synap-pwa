# Chakshu — Hey Snap, PWA controls, TTP and SD routing

**Target contract:** PWA shell `1.0.0-shell165-unified-hey-snap` or later, voice protocol **2**, media protocol **1**.  
**Firmware baseline before this change:** Synap OS build **1412**. The OTA feed remains authoritative for what is physically installable.  
**Device:** `xiao-esp32s3-sense-8m`, module id `3`, advertising name `synap-Chakshu`.

This document defines the current Chakshu interaction model. Odyssey C3/S3 do not have the Chakshu camera, SD inbox or local Hey Snap runtime.

## 1. Routing is determined by input source

BLE connection state no longer enables or disables Hey Snap.

| Input source | BLE connected | BLE disconnected | Destination |
| --- | --- | --- | --- |
| **Hey Snap → Record audio** | Supported | Supported | Chakshu SD WAV |
| **Hey Snap → Take a photo** | Supported | Supported | Chakshu SD JPG |
| **Hey Snap → Record video** | Supported | Supported | Chakshu SD video bundle |
| **Hey Snap → Explain what you see** | Supported | Supported | Tagged Chakshu SD JPG |
| **PWA mic control** | Supported | Not available | Phone/PWA recording journal |
| **PWA photo control** | Supported | Not available | Phone/PWA visual library |
| **PWA video control** | Supported | Not available | Phone/PWA media |
| **TTP223 double tap** | Start/stop PWA audio | Start/stop SD audio | Audio only |
| **TTP223 image/video** | Never | Never | Not supported |

The product invariant is therefore simple:

- **Voice means SD.**
- **PWA control means phone/PWA.**
- **Touch means audio only:** phone when connected, SD when disconnected.

A BLE connection is transport availability, not a Hey Snap ownership boundary.

## 2. Hey Snap lifecycle

The lightweight TinyML wake/command engine remains device-owned and stays armed across BLE connect and disconnect.

Current learned classes include:

- **Hey Snap**
- **Take a snap / photo**
- **Record a video**
- **Record audio**
- **Explain what you see**
- **Stop**

The wake phrase arms a short command window. Firmware clears the wake utterance from the classifier history before accepting an action, so field use should remain:

`Hey Snap` → brief pause → command.

### Startup

TinyML allocation is deferred until the normal BLE/SD boot path is healthy. It is no longer deferred until Chakshu is disconnected. Once initialized, the idle listener may run while BLE is connected.

### PWA capture pre-emption

The idle listener and the PWA audio stream share the microphone. PWA START takes the shared recursive microphone mutex before live capture begins. This prevents the idle voice reader and the first PWA capture read from racing.

While PWA audio is actively streaming, the voice classifier can receive a copy of completed PWA PCM frames, but a voice media command that needs the same capture resources returns busy instead of redirecting the live PWA take to SD.

### Stop semantics

A voice **Stop** applies only to a voice/TTP SD capture. It does **not** terminate a recording that was started from the PWA.

## 3. PWA voice integration

The PWA no longer sends a stand-down command when BLE connects.

On connection it:

1. discovers the voice control characteristic,
2. subscribes once to the voice event characteristic,
3. reads current voice status once,
4. observes wake/action/completion events,
5. never polls voice status or diagnostics on a timer.

This keeps Hey Snap available without reintroducing the earlier repeated-GATT traffic that interfered with media transfer.

Voice control opcodes remain protocol v2:

- opcode `0` — explicitly disable Hey Snap for diagnostics/manual control,
- opcode `1` — explicitly enable Hey Snap.

They are no longer BLE ownership handoff opcodes.

## 4. TTP223 behavior

Current hardware:

- **TTP223:** GPIO1 / D0
- **Battery ADC:** GPIO2 / D1
- **NeoPixel:** GPIO5 / D4
- **SD chip select:** GPIO21

Touch remains audio-only.

### BLE connected

Double tap uses the existing live audio transport:

- idle → PWA START,
- recording → PWA STOP / power-save flow.

The recording is stored in the phone/PWA path.

### BLE disconnected

Double tap toggles standalone SD audio:

- first double tap → start SD WAV,
- next double tap → stop/finalize SD WAV.

Touch must never start photo or video capture.

A deliberate 4-second hold still controls deep sleep/wake according to the existing power contract.

## 5. SD remains the durable local inbox

The SD card mounts independently of BLE and remains the durable source for Hey Snap and disconnected TTP audio.

Cold boot / re-detection follows the bounded clock sequence:

```text
10 MHz
  ↓ if mount fails
4 MHz
  ↓ if mount fails
1 MHz
```

Readiness requires more than a low-level mount: the firmware verifies the Synap directory and readable non-zero capacity before declaring SD healthy.

A later **Check SD card** can retry detection. Recovery never formats the card.

Unsynced media is not automatically evicted. When reserve space is insufficient, the new capture fails rather than deleting an unsynced original.

## 6. Capture and sync behavior

### Hey Snap capture

Voice-started media is written under `/synap/` regardless of BLE state.

Typical generated files are:

```text
/synap/XXXXXXXX-XXXXXXXX.jpg
/synap/XXXXXXXX-XXXXXXXX.mjpeg
/synap/XXXXXXXX-XXXXXXXX.wav
/synap/XXXXXXXX-XXXXXXXX.json
```

Current defaults:

- voice video: 10 seconds,
- voice audio: bounded to 60 seconds,
- describe: tagged JPG; visual inference runs after verified sync.

### PWA capture

PWA mic/photo/video controls use the connected live transport and store directly in the phone/PWA path. They do not create SD copies merely because an SD card is present.

### Reconnect and SD inbox

Connection does not silently delete SD data.

The PWA catalogues pending Synap captures and exposes:

- pending/unsynced state,
- per-item sync,
- **Sync all to Memories**,
- explicit storage re-check.

Verified move semantics remain transactional:

1. download source,
2. import into durable PWA storage,
3. verify bytes/digest,
4. only then delete the SD original,
5. refresh catalogue.

If transfer or verification fails, the SD original remains.

## 7. Resource-conflict rules

The routing model permits Hey Snap and BLE to coexist, but the physical camera/microphone/SD resources are still serialized.

Rules:

- PWA START owns the live microphone stream once admitted.
- A conflicting Hey Snap media action returns busy.
- An active SD media operation can block a new PWA media transition until the SD worker finalizes.
- OTA remains mutually exclusive with active capture.
- Existing files are finalized before state changes.
- No action changes its destination because BLE state changed after the action started.

This is intentionally different from the old model, which disabled Hey Snap for the whole connected session.

## 8. Acceptance criteria

Physical validation for the next OTA build should cover the full matrix:

1. Cold boot with SD inserted reports SD ready.
2. Connect PWA and keep BLE connected; **Hey Snap** still recognizes.
3. Connected **Hey Snap → Take a photo** creates an SD JPG, not a PWA photo.
4. Connected **Hey Snap → Record audio** creates an SD WAV, not a PWA recording.
5. Connected **Hey Snap → Record video** creates an SD video bundle.
6. Connected PWA mic control records into the phone/PWA journal and creates no SD WAV.
7. Connected PWA photo/video controls store to the phone/PWA path.
8. Connected TTP double tap starts/stops phone/PWA audio.
9. Disconnected TTP double tap starts/stops SD audio.
10. No TTP gesture starts image or video capture.
11. While Hey Snap idle listening is active, PWA START begins without first-frame loss or BLE stall.
12. During an active PWA recording, a conflicting voice media command is rejected/busy and does not corrupt or stop the PWA take.
13. Voice **Stop** does not terminate a PWA-started recording.
14. BLE disconnect/reconnect does not require re-arming Hey Snap.
15. Reconnect lists all unsynced SD items.
16. Successful verified sync deletes only the verified SD original.
17. Forced transfer/verification failure retains the SD original.
18. **Explain what you see** syncs the tagged image and then runs visual inference.
19. Diagnostics remain one-shot/on-demand rather than periodic.
20. Repeat wake/command recognition across independent real recording sessions; the current model remains a field baseline until stronger holdout data is available.

## 9. Relevant source files

| Path | Responsibility |
| --- | --- |
| firmware `firmware/xiao-sense/voice.cpp` | always-available TinyML runtime and SD voice actions |
| firmware `tools/boards/xiao-sense/index.cjs` | PWA microphone handoff and target materialization |
| firmware `firmware/xiao-sense/media-transfer.cpp` | SD jobs/catalogue/transfer |
| firmware `firmware/xiao-sense/sd-storage.cpp` | SD mount/recovery |
| PWA `devices/chakshu/voice.js` | one-shot status + voice event observation |
| PWA `devices/chakshu/media.js` | connected capture and SD catalogue |
| PWA `devices/chakshu/capture-preview.js` | verified SD import |
| PWA `touch-event-bridge.js` | shared touch/battery event presentation |

The XIAO ESP32-S3 Sense orange USER_LED remains electrically tied to GPIO21 / SD CS. SD access can therefore flash it even though Synap does not use it as a semantic status LED.
