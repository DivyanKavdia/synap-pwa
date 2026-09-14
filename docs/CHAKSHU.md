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
