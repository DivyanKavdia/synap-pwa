# Chakshu in the PWA

Connect the device through the normal pendant picker. The Device panel reads firmware identity automatically and shows **Chakshu**, its camera sensor and initialized features.

- Main microphone control: standard Synap audio recording, playback, transcription and memory.
- Settings → Device → Chakshu: hardware recheck, photo to SD, ten-second WAV to SD, and a silent two-fps MJPEG camera clip to SD.
- Short checks report capacity, progress, errors and the saved filename. Import their files using Browse SD card or a card reader; the checks do not automatically add files to the PWA Library.
- Live audio, OTA and SD checks cannot run together. Completed results can be read after a reconnect; reboot clears the last result but keeps saved files.
- Chakshu stays awake and requires no touch sensor, external LED or battery divider.

The Chakshu profile supports XIAO ESP32S3 Sense with 8 MB flash / 8 MB OPI PSRAM and probes the installed card. It does not assume the 2 GB card is empty, delete files or auto-format it.

## Browse and work with photos and videos

In **Library → Photos & video**, search titles, notes and saved descriptions, filter by media type, or select **Favourites**. Titles, notes and favourites are saved in this browser for the signed-in account and remain available after reconnecting or reopening the PWA. Other accounts cannot see these items.

Open a photo to zoom the view, add a title or notes, link a saved audio recording, ask a question, or choose **Read text in view**. Text reading uses the same cloud vision service as descriptions; it does not create an audio transcript. The original JPEG remains available to download.

Video cards show **Play video**. Open one for play/pause, elapsed time, a seekable timeline, playback speed, and previous/next frame controls. Seeking pauses at the chosen moment. **Play linked audio** synchronizes the separately saved soundtrack with the frames; turn it off for silent playback. Playback pauses when the page is hidden or the viewer closes. Saved descriptions have **View at…** buttons that return to their frame. Describing a moment keeps the current position and sends only that frame and up to two nearby frames on either side.

**Save frame as photo** copies the selected JPEG into its own library item with the original video timestamp and audio link. Deleting the source video leaves both the extracted photo and its separate audio recording intact. The linked audio retains its own player and transcript, even when played in sync with video. Audio-only takes remain separate from video soundtracks.

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

Short camera commands use write without response when firmware advertises it; the matching request ID in the result confirms execution. Older firmware and requests containing longer SD paths retain write with response. Missing results time out, and an ambiguous write failure never repeats a photo exposure. A failed video transfer immediately enters saving while the owned audio take finishes; the preview shows that transition instead of claiming recording continues.

Camera errors identify control discovery, data discovery, command write or
response read. Diagnostics retain that stage, request ID, byte offset and elapsed
time, and distinguish a queued timeout from an operation running on Bluetooth.
The queue gives each operation its own execution deadline after bounded waiting.
Native bridge failures reported as strings retain their message in the preview
and diagnostic log. Startup diagnostics also identify the loaded recorder,
camera and capture UI revisions, so an old cached module is distinguishable
from a failure in the current build.

Module and event discovery wait until identity, audio/control subscriptions and recovery negotiation finish. The app releases optional setup explicitly after that handshake, including after a reconnect.

Voice discovery waits until the connection handshake is complete. Commands and
their lease can be restored during a confirmed recording after reconnecting.
Failed setup attempts also respect the two-second
poll interval; media progress cannot cause an immediate retry burst.

Photos and video are stored in a separate, account-keyed IndexedDB library **on the current browser**. They are not cloud-synced. Audio follows the existing local/cloud processing flow. Account changes close viewers, revoke object URLs, abort pending descriptions, and stop owned online captures. Interrupted visual captures remain accessible under their original owner. Deleting a visual does not delete linked audio. Download originals before clearing browser data.

### Descriptions and spoken “explain”

Only audio enters transcription. A timestamped “explain” word from an audio segment selects the nearest saved camera frame and at most two frames on either side, with a ten-second maximum distance. Explicit live requests allow up to twelve seconds for following frames to arrive. A missing frame window produces no invented explanation. Duplicate voice requests are suppressed. Voice requests follow rolling audio transcription, so they are delayed by the audio segment/transcription pipeline; the **Explain this moment** button requests a frame window directly.

The backend accepts up to five JPEG images and a prompt, validates account association and size, and sends those images to vision inference. It never submits a video file or audio to that endpoint. Descriptions and their exact selected timestamps are stored locally with the visual. A user can select another saved frame and ask a question in the viewer. Text is rendered as text, not HTML.

### Import and playback

Browse SD card transfers files through Bluetooth; the current firmware catalogue lists up to 100 photos/clips. For larger archives or faster import, select files with a card reader. Import the matching `.mjpeg`, `.wav`, and `.json` together to retain audio alignment. Earlier clips without JSON use estimated two-fps playback and disable automatic spoken explanations. JPEG photos also import directly. Camera/audio imports are limited to 32 MiB per file. Incomplete JPEG streams or inconsistent timing files are rejected.

The viewer plays frames at their saved timestamps and follows the linked audio clock when enabled. It also supports silent clips and a silent video tail after a shorter soundtrack ends. Audio remains independently stored with its own transcript link. Audio can be linked or replaced from recordings belonging to the same account. Original video export is MJPEG plus a JSON timing sidecar; original audio remains downloadable through the audio recording.

See [device capabilities](DEVICE_CAPABILITIES.md) for supported/readiness/permission gates and catalog synchronization.

## Code boundaries

| Responsibility | Owner |
| --- | --- |
| BLE connection, serialized queue and audio ownership | app.js, recording/bluetooth-session.js, devices/identity.js |
| Module descriptor and hardware checks | devices/modules.js, devices/panel.js |
| Camera/file transport | devices/chakshu/transfer.js |
| Account association, capture and audio links | devices/chakshu/media.js |
| Account-keyed media and frame storage | devices/chakshu/store.js |
| Library and selected-frame descriptions | devices/chakshu/library.js, devices/chakshu/library.css |
| Timestamped playback and linked audio clock | devices/chakshu/player.js |
| Header photo/video preview popup | devices/chakshu/capture-preview.js |
| Encrypted account device association and vision endpoint | backend/src/http/routes/chakshu.ts |
| Timestamped audio transcription events | synap-backend.js, backend/src/http/routes/recordings.ts |
| Firmware capture and SD worker | synap-firmware repository |

Native media operations use the app-owned GATT queue. Media has explicit permission during confirmed audio recording; passive metadata reads retain their existing idle-only policy. Recovery, finalization, OTA, another tab's ownership and stale connections block media access. An SD take blocks starting live audio; online camera capture shares ordinary audio notifications.

## Protocols

The existing `4fa12350` descriptor and `4fa12351`–`53` SD-check protocol remain. Descriptor byte 14 advertises the media extension version; byte 15 is zero (local voice removed). `4fa12354`/`55` provide request/response frame and file transfer. All UUIDs share suffix `-0000-1000-8000-00805f9b34fb`.

See the [firmware media protocol and setup](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/CHAKSHU.md) for wire fields and limits.

## Header controls

The microphone button starts/stops audio, the camera button takes a photo, and the video button opens preview and records timestamped frames with separate audio. Local voice recognition, voice settings, model installation and background voice BLE services are removed for this release. Descriptor voice version is zero in the matching firmware. The PWA also avoids voice/model discovery against older firmware.

Video requests use QVGA frames on the new firmware, while standalone photos and SD captures remain VGA. The preview reports camera transfer percentage. Bluefy read latency still limits the achieved frame rate; this is a sequence of timestamped JPEGs, not a guaranteed continuous-motion video stream. Stopping video cancels its pending camera read and preserves completed frames and received audio. An AbortError at that exact Stop boundary alone does not establish a failed camera or a disconnected link.

Update Chakshu firmware and reconnect after updating this page. A PWA reload does not change the firmware already running on the pendant.

## Startup stability audit

Shell 117 fixes startup queue timeouts that could disconnect a healthy pendant,
defers automatic firmware discovery for five seconds, and keeps passive checks
out of manual camera/video capture. Slow Bluetooth requests log queue and native
durations separately. Chakshu diagnostics v3 includes measured boot/media time,
the previous link's duration and parameters, and the stage reached before a drop.

The matching firmware removes a duplicate data-length request and keeps the
central's connection parameters. See the
[full startup audit](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/chakshu-startup-audit.md)
for evidence, validation and physical-device limits.
