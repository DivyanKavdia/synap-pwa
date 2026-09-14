# Chakshu in the PWA

Connect the device through the normal pendant picker. The Device panel reads firmware identity automatically and shows **Chakshu**, its camera sensor and initialized features.

- Main microphone control: standard Synap audio recording, playback, transcription and memory.
- Settings → Device → Chakshu: hardware recheck, photo to SD, ten-second WAV to SD, and a silent two-fps MJPEG camera clip to SD.
- Short checks report capacity, progress, errors and the saved filename. Import their files using Browse SD card or a card reader; the checks do not automatically add files to the PWA Library.
- Live audio, OTA and SD checks cannot run together. Completed results can be read after a reconnect; reboot clears the last result but keeps saved files.
- Chakshu stays awake and requires no touch sensor, external LED or battery divider.

The initial firmware supports XIAO ESP32S3 Sense with 8 MB flash / 8 MB OPI PSRAM and probes the installed card. It does not assume the 2 GB card is empty, delete files or auto-format it.

## Account photo/video library

Library → Photos & video shows **Unavailable** until a Chakshu device is associated with the signed-in account. Connecting an identified Chakshu while signed in saves that association in the backend. The library stays available after disconnection and can use the cached association offline. C3/S3 and unknown hardware do not unlock it. A public device ID is an account preference, not proof of exclusive hardware ownership.

Choose a capture mode:

| Mode | Behavior |
| --- | --- |
| Audio only | Existing audio recording, playback, transcription and memory, with Chakshu's onboard PDM microphone specifications. |
| Image | Take a fresh photo, start audio with a photo, describe it, or link an existing audio recording. Photo with audio keeps recording until the audio control is stopped. |
| Video online | Capture periodic JPEG frames while the ordinary audio journal records independently. Optional live descriptions run at most once every ten seconds, with one automatic request in flight. Keep the PWA open; radio throughput determines frame rate. Clips stop at 32 MiB of visual data. |
| Video to SD | Firmware records up to 60 seconds with separate silent MJPEG, PCM WAV and JSON timing files. An accepted take continues without the phone. Reconnect to check status and import it. |

Camera transfers and paired SD video need firmware advertising media extension version 1. Older Chakshu firmware can still use ordinary audio and manual SD imports. There is no Wi-Fi or high-frame-rate MP4 stream.

Photos and video are stored in a separate, account-keyed IndexedDB library **on the current browser**. They are not cloud-synced. Audio follows the existing local/cloud processing flow. Account changes close viewers, revoke object URLs, abort pending descriptions, and stop owned online captures. Interrupted visual captures remain accessible under their original owner. Deleting a visual does not delete linked audio. Download originals before clearing browser data.

### Descriptions and spoken “explain”

Only audio enters transcription. A timestamped “explain” word from an audio segment selects the nearest saved camera frame and at most two frames on either side, with a ten-second maximum distance. Explicit live requests allow up to twelve seconds for following frames to arrive. A missing frame window produces no invented explanation. Duplicate voice requests are suppressed. Voice requests follow rolling audio transcription, so they are delayed by the audio segment/transcription pipeline; the **Explain this moment** button requests a frame window directly.

The backend accepts up to five JPEG images and a prompt, validates account association and size, and sends those images to vision inference. It never submits a video file or audio to that endpoint. Descriptions and their exact selected timestamps are stored locally with the visual. A user can select another saved frame and ask a question in the viewer. Text is rendered as text, not HTML.

### Import and playback

Browse SD card transfers files through Bluetooth; the current firmware catalogue lists up to 100 photos/clips. For larger archives or faster import, select files with a card reader. Import the matching `.mjpeg`, `.wav`, and `.json` together to retain audio alignment. Earlier clips without JSON use estimated two-fps playback and disable automatic spoken explanations. JPEG photos also import directly. Camera/audio imports are limited to 32 MiB per file. Incomplete JPEG streams or inconsistent timing files are rejected.

The viewer plays silent frames with their saved timing and has a separate audio player/transcript link. Audio can be linked or replaced from recordings belonging to the same account. Original video export is MJPEG plus a JSON timing sidecar; original audio remains downloadable through the audio recording.

## Code boundaries

| Responsibility | Owner |
| --- | --- |
| BLE connection, serialized queue and audio ownership | app.js, recording/bluetooth-session.js, device-identity.js |
| Module descriptor and hardware checks | device-modules.js, chakshu-ui.js |
| Local command lease and routing | chakshu-voice.js |
| Camera/file transport | chakshu-transfer.js |
| Account association, capture and audio links | chakshu-media.js |
| Account-keyed media and frame storage | chakshu-store.js |
| Library, playback and selected-frame descriptions | chakshu-library.js, chakshu-library.css |
| Encrypted account device association and vision endpoint | backend/src/http/routes/chakshu.ts |
| Timestamped audio transcription events | synap-backend.js, backend/src/http/routes/recordings.ts |
| Firmware capture and SD worker | synap-firmware repository |

Native media operations use the app-owned GATT queue. Media has explicit permission during confirmed audio recording; passive metadata reads retain their existing idle-only policy. Recovery, finalization, OTA, another tab's ownership and stale connections block media access. An SD take blocks starting live audio; online camera capture shares ordinary audio notifications.

## Protocols

The existing `4fa12350` descriptor and `4fa12351`–`53` SD-check protocol remain. Descriptor byte 14 advertises the media extension version; byte 15 advertises voice extension version 1. `4fa12354`/`55` provide request/response frame and file transfer. All UUIDs share suffix `-0000-1000-8000-00805f9b34fb`.

See the [firmware media protocol and setup](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/CHAKSHU.md) for wire fields and limits.

## Header controls and local voice

Photo and video buttons sit beside the microphone. They show unavailable until the account has a Chakshu association and require a connected camera for capture. Audio-only keeps the normal C3/S3 journal behavior. Starting video seals any audio-only take and creates a fresh audio journal linked to a separate silent video record. The video button stops both parts; the microphone button saves video and starts a new audio-only take. A photo during video saves the latest available video frame with its audio position.

For local commands, install the matching firmware and copy `synap/models/srmodels.bin` from the release's `chakshu-voice-model.zip` onto the SD card, preserving existing files. Restart the pendant. Settings → Device → Local voice controls shows readiness and an enable switch. Say **“Hi Chakshu”**, pause, then one of **“take photo”** (or **“click photo”**), **“start video”**, **“stop video”**, **“audio on”**, or **“audio off”**. Repeat the activation phrase for each command. Audio off stops recording; the separate voice-control switch stops command listening.

Recognition runs on Chakshu. An associated, visible, connected PWA renews a six-second command lease through its existing GATT queue and routes recognized actions to these same controls. Duplicate notifications are ignored; a bounded queue preserves a stop arriving during startup. Hidden pages release the lease, and a disconnected page cannot replay commands into another account. Without a current lease, the pendant saves JPEG photos, paired video/WAV/JSON takes, or standalone audio WAV takes on SD. SD audio and video takes are each bounded to 60 seconds. Switching offline modes closes the current files before opening new ones. Import the files when reconnected, or use a card reader.

The model uses MultiNet phoneme commands with “Hi Chakshu” as an activation gate. This is not a separately trained wake-word model. Recognition accuracy, false activations, runtime memory and battery use require device measurement. Missing or invalid model files leave the ordinary capture controls available and show a model setup message.

## Verification boundary

Run `npm test`, backend typechecking/tests, and `npm run test:browser -- chakshu chakshu-library`. Browser fixtures cover account gating/switching, JPEG transfers, local playback, separate audio/video, selected-frame inference and SD import. Backend tests exercise the real authenticated routes, encrypted association and rejection of other accounts. Firmware CI compiles C3, S3 and Chakshu. Camera/microphone quality, timing alignment, actual Bluetooth throughput and on-device flash still require hardware validation.
