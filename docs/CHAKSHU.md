# Chakshu in the PWA

Connect through the normal pendant picker. The Device panel identifies Chakshu from the firmware descriptor and shows the camera sensor and initialized features. Chakshu uses the XIAO ESP32S3 Sense with 8 MB flash and 8 MB OPI PSRAM, an onboard PDM microphone and a camera. Local voice recognition and model loading remain disabled.

## Phone-only capture

| Control              | Behavior                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Microphone           | Standalone audio recording, local playback, cloud transcription and memory.                                                                |
| Photo                | A fresh JPEG saved to this phone, with no cloud upload or description.                                                                     |
| Photo with audio     | Save any previous standalone take, then start a new local soundtrack and photo. Stop the microphone when finished.                         |
| Video                | Save any previous standalone take, then record timestamped JPEG frames with a new local soundtrack. Stop saves completed frames and audio. |
| Hardware recheck     | Re-read readiness and retry initialization while idle.                                                                                     |
| Ten-second WAV to SD | An explicit standalone audio hardware check, separate from photo/video capture.                                                            |
| Browse/import SD     | Bring existing JPEG or matching MJPEG, WAV and JSON files into the phone library.                                                          |
| Wi-Fi downloads      | Temporarily download existing SD files over a private local network, with capture stopped.                                                 |

New visual captures always use phone storage even with an SD card inserted. The app does not start new photo/video writes to SD. Existing files are preserved; card rechecks never format or delete them. The firmware can still report an older SD take in progress, and its Stop control remains available.

The microphone button's standalone recordings retain their normal transcription policy. A video soundtrack gets a durable `localOnly` flag before any samples are stored. It creates no transcription or summary jobs, and both the generic queue and cloud adapter block stale/manual jobs. Paired SD imports also keep the soundtrack local. An older independent audio recording manually linked to a photo retains its own existing policy.

Photos, frames, notes and paired soundtracks are stored in IndexedDB on the current phone/browser. They are neither cloud-synced nor submitted to cloud vision. Automatic descriptions, spoken explanations and OCR controls are removed. The old `/v1/chakshu/describe` endpoint rejects all requests with `410 local_media_only` before parsing JSON. Previously saved text descriptions can still be viewed locally. This release does not delete historical cloud audio or previously submitted results.

Export originals before clearing browser data. Local media has no automatic cloud backup and is not a promise of permanent storage by the mobile browser.

## Hardware and performance limits

Camera capture requires an associated, connected Chakshu with media protocol v1 and ready camera/photo/video flags. Video also requires a ready microphone. Firmware build 1244's bounded notification windows improve transfers when advertised; older compatible firmware retains the read transport. This app/backend release does not change firmware or negotiate more aggressive radio parameters.

Standalone photos use VGA originals on current firmware; video requests QVGA frames. The phone records a sequence of timestamped JPEG images with separate PCM sound, not hardware-encoded MP4. Bluetooth throughput and simultaneous audio limit the achieved frame rate. Keep Synap visible and the pendant nearby. Camera requests remain serial; capture/transfer time counts toward cadence, and audio recovery takes priority. Clips stop at 32 MiB of visual data.

The transfer protocol acknowledges contiguous byte offsets and retries missing chunks without repeating the photo exposure. Commands use write without response when supported and verify a matching request ID. Failed transfers save the completed media and received audio. Stop cancels pending camera work while the native GATT queue retains ownership until that request settles.

## Library and playback

**Library → Photos & video** is available to a signed-in account associated with a Chakshu. Connecting identified hardware records that association; cached association works offline. Other accounts cannot open the local visual library. Account association does not prove exclusive physical ownership of a public device ID.

Search titles, notes and historical descriptions; filter images/videos and favourites. Open a photo to zoom, rename, add notes, link audio or download the JPEG. Open a video for playback, seeking, playback speed, previous/next frame and linked audio controls. Playback follows saved timestamps and pauses when the page is hidden or the viewer closes. It supports a silent tail when frames extend past the soundtrack.

**Save frame as photo** copies the selected JPEG with its original timestamp. Deleting the video keeps that extracted photo and the separately stored soundtrack. Open linked audio for playback or WAV export; local soundtracks show **On this device**, without missing-transcript warnings or a cloud-download fallback. Video export produces MJPEG plus a JSON timing sidecar; export the soundtrack separately as WAV.

Account changes close viewers, revoke object URLs and cancel owned captures. Interrupted visual takes stay accessible to their original account. Starting a new video waits for any previous standalone recording to finish saving so audio from separate takes is not mixed.

## Existing SD files

Use **Check SD card** after inserting a card. A ready card enables browsing and downloads, while phone capture works without it. Browse SD transfers files through Bluetooth; the current catalog lists up to 100 photos/clips. For faster completed-file transfers, use Wi-Fi downloads or a card reader.

Import the matching `.mjpeg`, `.wav` and `.json` together to preserve actual timing and a local soundtrack. Earlier clips without timing JSON use an estimated two-fps timeline. JPEG photos import directly. A standalone WAV can be imported for normal transcription; a WAV paired with video is not duplicated as a cloud-eligible audio take. Imports are limited to 32 MiB per file, and incomplete JPEG streams or inconsistent timing are rejected.

For Wi-Fi downloads, copy the displayed password, join **Chakshu-XXXX** in the phone settings and open the private download link. The local page is separate from the HTTPS PWA. Save the desired files, choose **Finish downloads**, return to the normal network and import them into Synap. Credentials remain in memory and stay out of logs. The network expires after three minutes without requests or fifteen minutes overall. Audio, camera capture, card remount and OTA wait until downloads finish.

## Connection diagnostics

Module/event discovery waits until identity, audio/control subscriptions and recovery negotiation finish. Passive checks are deferred during capture. Logs include operation stage, request ID, offset, queue time and native Bluetooth time. Camera response reads have their own ten-second deadline; a native read that never settles causes bounded recovery.

The build-1242 logs showed 720 ms link supervision timeouts. The firmware follow-up requests the standard S3's six-second timeout once outside the connection callback, with bounded busy retries. Later user diagnostics observed 6000 ms; that improvement does not establish end-to-end RF reliability. The app separately reports **Audio delayed** when received audio falls far behind elapsed time.

See the [startup audit](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/chakshu-startup-audit.md), [transport audit](CHAKSHU_TRANSPORT_AUDIT.md) and [audio pipeline](AUDIO_PIPELINE.md). A screenshot or simulated test cannot certify microphone quality, physical radio endurance or mobile background delivery.

## Code and protocol boundaries

| Responsibility                                        | Owner                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| Connection, serialized GATT queue and audio ownership | `app.js`, `recording/bluetooth-session.js`, `devices/identity.js` |
| Hardware descriptors and checks                       | `devices/modules.js`, `devices/panel.js`                          |
| Camera and file transfer                              | `devices/chakshu/transfer.js`                                     |
| Account association and capture                       | `devices/chakshu/media.js`                                        |
| Visual persistence and playback                       | `devices/chakshu/store.js`, `library.js`, `player.js`             |
| Local soundtrack policy                               | `audio-store.js`, `processing-queue.js`, `synap-backend.js`       |
| Legacy cloud image rejection                          | `backend/src/http/routes/chakshu.ts`, `backend/src/http/app.ts`   |

The existing `4fa12350` descriptor and `4fa12351`–`53` hardware-check protocol remain. Descriptor byte 14 advertises media, byte 15 is zero for local voice, and byte 16 advertises optional transfer/download features. `4fa12354`/`55` provide frame/file requests and responses. See the [firmware protocol](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/CHAKSHU.md) and [capability guide](DEVICE_CAPABILITIES.md).

The current app revision is `1.0.0-shell121-chakshu` with capture UI revision `1.0.0-chakshu-core6`. A PWA reload updates the app; it does not flash the pendant.
