# Chakshu in the PWA

Connect the device through the normal pendant picker. The Device panel reads firmware identity automatically and shows **Chakshu**, its camera sensor and initialized features.

- Main microphone control: standard Synap audio recording, playback, transcription and memory.
- Settings → Device → Chakshu: hardware recheck, photo to SD, ten-second WAV to SD, and a silent two-fps MJPEG camera clip to SD.
- Short checks report capacity, progress, errors and the saved filename. Read the SD card to review files; these checks do not add files to the PWA Library.
- Live audio, OTA and SD checks cannot run together. Completed results can be read after a reconnect; reboot clears the last result but keeps saved files.
- Chakshu stays awake and requires no touch sensor, external LED or battery divider.

The initial firmware supports XIAO ESP32S3 Sense with 8 MB flash / 8 MB OPI PSRAM and probes the installed card. It does not assume the 2 GB card is empty, delete files or auto-format it.

## Code boundaries

| Responsibility | Owner |
| --- | --- |
| BLE connection, queue and recording state | app.js, recording/bluetooth-session.js |
| Versioned module descriptor and SD-check client | device-modules.js |
| Capability-driven Device panel | chakshu-ui.js, device-modules.css |
| Target-specific update checks and image validation | releases.js, ota.js |
| Offline module availability | index.html, sw.js, enhancements.js |
| Real hardware capture and storage | synap-firmware repository |

The optional client consumes the app-owned GATT service. It pauses discovery/status reads while audio or OTA owns the connection and rejects stale connection results. Display names do not determine hardware compatibility. Older C3/S3 firmware falls back to its exact target identity; unknown modules do not gain camera/storage controls.

## Protocol v1

All UUIDs share suffix -0000-1000-8000-00805f9b34fb.

| UUID prefix | Use |
| --- | --- |
| 4fa12350 | 20-byte capability descriptor, read |
| 4fa12351 | Four-byte command [0xC8, 1, operation, requestId], write with response |
| 4fa12352 | 20-byte operation result, read |
| 4fa12353 | Last SD filename, read |

Operations: 1 recheck, 2 photo, 3 ten-second WAV, 4 ten-second silent MJPEG.
Request IDs are 1–255; the client chooses a different ID from the last firmware result.
An accepted operation is not automatically retried, and repeated IDs do not capture twice.
Capacity fields use MiB, not marketed GB. The descriptor separates supported from initialized features.

Future work: SD file listing/download, continuous/offline audio, synchronized audio/video, Wi-Fi preview and cloud image/video understanding. The ten-second SD checks do not solve long background recordings.

See [firmware setup and pin map](https://github.com/DivyanKavdia/synap-firmware/blob/feature/chakshu-module/docs/CHAKSHU.md) for first-flash instructions.


### Wire fields (little endian)

| Bytes | Capability (0xC7) | Check status (0xC9) |
| --- | --- | --- |
| 0–1 | Magic, schema=1 | Magic, schema=1 |
| 2–3 | Module ID (S3=1, C3=2, Chakshu=3), control extension=1 | Operation, request ID |
| 4–5 | Supported feature bits, uint16 | State (idle=0, busy=1, complete=2, failed=3), error |
| 6–7 | Ready feature bits, uint16 | Ready mic/camera/SD bits, progress 0–100 |
| 8–9 | Camera sensor PID, uint16 | Part of total MiB |
| 10–11 | Sample rate, uint16 | Part of total MiB |
| 12–13 | Flash MiB, PSRAM MiB | Part of free MiB |
| 14–15 | Reserved | Part of free MiB |
| 16–19 | Reserved | Written payload bytes, uint32 |

Status bytes 8–11 and 12–15 are uint32 total/free MiB.
Feature bits: audio=1, camera=2, SD=4, persistent settings=8, touch=16, battery=32, standby=64, silent MJPEG=128, SD WAV=256, photo=512.
WAV written payload bytes exclude its 44-byte header.

An ATT write response only confirms delivery to the characteristic. The client waits up to five seconds for a matching operation/request ID in the firmware result, reports an unconfirmed command, and never automatically repeats a capture.
