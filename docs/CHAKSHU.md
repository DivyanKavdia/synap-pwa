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
camera, voice and capture UI revisions, so an old cached module is distinguishable
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
| Local command lease and routing | devices/chakshu/voice.js |
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

The existing `4fa12350` descriptor and `4fa12351`–`53` SD-check protocol remain. Descriptor byte 14 advertises the media extension version; byte 15 advertises voice extension version 1. `4fa12354`/`55` provide request/response frame and file transfer. All UUIDs share suffix `-0000-1000-8000-00805f9b34fb`.

See the [firmware media protocol and setup](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/CHAKSHU.md) for wire fields and limits.

## Header controls and local voice

Photo and video buttons sit beside the microphone. They show unavailable until the account has a Chakshu association and require a connected camera for capture. Audio-only keeps the normal C3/S3 journal behavior. Starting video seals any audio-only take and creates a fresh audio journal linked to a separate silent video record. The video button stops both parts; the microphone button saves video and starts a new audio-only take. A photo during video saves the latest available video frame with its audio position.

The header camera/video buttons immediately open a preview popup. It shows the actual saved photo or latest captured video frame, plus waiting/error status while capture starts. During video, **Take photo** saves a frame and **Stop & save video** finishes both separate recordings. Closing the preview keeps recording; the popup explains this. After saving, **Open in library** opens the captured item. Preview reads the existing capture stream and does not start another camera or audio stream. Online capture and playback need no SD card; disconnected/offline recordings still require SD storage.

For local commands, install the current Chakshu firmware through **Settings → Firmware**, then reconnect. Published Chakshu images include the voice model in internal flash; there is no separate model upload or SD requirement. Settings identifies the embedded model and hides the SD installer. Older/manual builds without embedded weights retain the **Install voice model** SD fallback. Enable Local voice controls if the listener was previously switched off. Settings → Device → Local voice controls shows readiness and an enable switch. Say **“Hi Chakshu”**, pause, then one of **“take photo”** (or **“click photo”**), **“start video”**, **“stop video”**, **“audio on”**, or **“audio off”**. Repeat the activation phrase for each command. Audio off stops recording; the separate voice-control switch stops command listening.

Recognition runs on Chakshu. An associated, visible, connected PWA renews a six-second command lease through its existing GATT queue and routes recognized actions to these same controls. Duplicate notifications are ignored; a bounded queue preserves a stop arriving during startup. Hidden pages release the lease, and a disconnected page cannot replay commands into another account. Without a current lease, the pendant saves JPEG photos, paired video/WAV/JSON takes, or standalone audio WAV takes on SD. SD audio and video takes are each bounded to 60 seconds. Switching offline modes closes the current files before opening new ones. Import the files when reconnected, or use a card reader.

The model uses MultiNet phoneme commands with “Hi Chakshu” as an activation gate. This is not a separately trained wake-word model. Recognition accuracy, false activations, runtime memory and battery use require device measurement. Missing or invalid model files leave the ordinary capture controls available and show a model setup message.

## Updating older Chakshu firmware

Before build 1227, Chakshu's BLE wrapper can acknowledge a write before its deferred callback copies the packet. Sending several chunks together can then report **Chunk order or duplicate mismatch**. The PWA sends one chunk per firmware acknowledgement for these older Chakshu builds, including resumed transfers. Native-callback Chakshu builds (1227 onward), C3 and ordinary S3 retain the existing window. Image target, device identity, cumulative offset, SHA-256 and commit validation remain enforced. Reopen the updated PWA, reconnect, and retry the update if an earlier transfer failed; the fix is in the PWA and can install the newer firmware.

## Verification boundary

Run `npm test`, backend typechecking/tests, and `npm run test:browser -- chakshu chakshu-library`. Browser fixtures cover account gating/switching, JPEG transfers, local playback, separate audio/video, selected-frame inference and SD import. Backend tests exercise the real authenticated routes, encrypted association and rejection of other accounts. Firmware CI compiles C3, S3 and Chakshu. Camera/microphone quality, timing alignment, actual Bluetooth throughput and on-device flash still require hardware validation.
