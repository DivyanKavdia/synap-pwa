# Chakshu camera and audio audit — 15 September 2026

Scope: the reported Bluefy/iOS session through 17:08:05 UTC, firmware 1242
and 1243, the app's shared Bluetooth queue, camera transfer client, recorder,
diagnostics and recording status. This follow-up ships as shell 119 / core4.
It does not publish another firmware binary.

## What the evidence establishes

| Observation | Interpretation |
| --- | --- |
| Build 1242 stays connected for 1,809,436 ms before the 17:00:37 hidden-page disconnect. Its retained supervision timeout is 720 ms. | A roughly 30-minute link, ending in a radio supervision timeout. This precedes the 1243 update. |
| The 17:03:27 disconnect occurs in `updating`; the subsequent camera failure reports build 1243. | The update reboot and the later camera failure are separate events. |
| At 17:06:01, `Read Chakshu camera response` times out after 3,510 ms at byte offset 960, then the app explicitly disconnects. | This disconnect is initiated by the app's deadline. The log does not establish a radio supervision timeout on 1243. |
| The following 22-second take contains 440 complete PCM frames, 1,760 packets, no missing or incomplete frames, and seals normally. | Audio delivery works for this take after reconnection. |
| The next take receives 1.3 seconds of complete audio in 10.178 seconds; frames continue arriving during Stop. | Delivery is much slower than capture time. The excerpt ends during drain, so its final saved duration and losses are unknown. |
| The slow-audio diagnostic read says `Unsupported pendant diagnostics`. The open page continues its existing session numbers through both firmware updates. | An older loaded decoder is a plausible explanation: shell 117 rejects v4, while shell 118 and 119 accept it. There is no new application-start line proving a page reload in this excerpt. |
| An idle camera failure reports 147 invalid audio packets but no received audio packets. | The old app increments invalid counters for empty/short idle callbacks before checking recording state. This count alone does not establish corrupt recorded audio. |

The earlier 1242 boot measurements are 1,625 ms to ready, including 1,106 ms
for media initialization. Those measurements do not support blaming a voice
model for the later camera read timeout. The installed core firmware reports
voice protocol zero and the current board adapter includes no voice model.

## Confirmed app defects and changes

### Camera read budget

`devices/chakshu/transfer.js` polls for a matching media response for up to
12 seconds, but its native reads previously inherited the recorder's
3.5-second deadline. `app.js` disconnects an idle connection when that deadline
expires. A deterministic test reproduces that premature disconnect with a
six-second read at offset 960.

Camera reads now explicitly request a ten-second native budget through
`devices/identity.js` and the existing serialized session. Control command
deadlines remain 3.5 seconds. Queue waiting is budgeted separately. Only one
native request runs at a time, including after cancellation. A photo command
is never replayed merely because its response is slow. A read that never
returns still times out and recovers an idle link.

This increases tolerance for delayed native callbacks. It does not increase
radio bandwidth or prove that the specific failed physical read would have
returned within ten seconds.

### Misleading recording status

Previously any recent complete frame kept the header at `Listening`, including
the observed slow trickle. After ten seconds in the foreground, received audio
below half of elapsed capture time now displays `Audio delayed`. Both incoming
frames and the UI timer use the same condition, avoiding status flicker.
The received-duration counter stays visible. Stop remains available; moment
marking is disabled until reception catches up. An actual absence of recent
frames still uses the existing waiting/recovery path.

### Diagnostic evidence

Slow-delivery logs now include whether a camera operation or live video is
active and its transfer progress. A rejected firmware diagnostic includes its
response length, marker, version, page revision and firmware build. This
distinguishes version skew from an empty or unrelated response without guessing.
Malformed audio received during capture still counts as invalid; idle callbacks
no longer alter recording packet counters.

## Firmware paths reviewed

The matching source is in
[synap-firmware](https://github.com/DivyanKavdia/synap-firmware/tree/279c08bf1c722c4a4192a3b35eb8aa213ff7a735).

| Path | Review result |
| --- | --- |
| `firmware/xiao-sense/media-transfer.cpp` | Camera exposure, selected-image ownership and SD reads run in a worker. The GATT read callback copies a bounded response; it does not capture a frame or read SD. Whole-image serialization in the app prevents another command replacing the selected source midway. |
| `firmware/xiao-sense/ble-audio.cpp` and `recovery-frame.cpp` | Congested PCM fragments retain their position. Notification allocation checks actual free host buffers and reserves capacity for control traffic. A successful enqueue is not proof of delivery to the phone. |
| `firmware/shared/audio-transport.cpp` and `audio-session.cpp` | Audio uses its own capture/transmit path and recovery buffer. Stop permits buffered frames to drain; the long drain is consistent with a delivery backlog but does not identify its cause. |
| `firmware/xiao-sense/ble-link.cpp` and `ble-server.cpp` | Build 1243 requests a six-second supervision timeout when the observed timeout is shorter. Submission is distinct from acceptance; diagnostics v4 records the actual observed parameters. The supplied post-update excerpt has no decoded v4 snapshot proving what the central accepted. |
| `tools/boards/xiao-sense/index.cjs` and `firmware/xiao-sense/camera.cpp` | The adapter uses onboard PDM PCM16 capture, camera and SD code without local voice initialization. Camera initialization and boot timings are measured. |

No new firmware defect is established by the latest excerpt. Audio bandwidth,
phone scheduling, RF conditions and simultaneous media traffic remain possible
contributors to the slow take. The additional context and decoded capture/TX
counters are needed to distinguish them. The 18 older processing retries and
empty transcripts are a separate processing issue; this patch preserves them.

## Validation and remaining device check

Regression tests use the production camera client, device policy and native
queue to cover a six-second idle read, cancellation followed by Stop, and a
ten-second hung-read deadline. Browser coverage exercises a delayed idle photo,
ordinary audio/video capture and saved media, plus throttled audio that displays
the delay, catches up, and saves through the original journal. Decoder tests
exercise the recorder's v4 diagnostic path and incompatible response metadata.

These tests use simulated Bluetooth. They establish app behavior, not sustained
physical Chakshu/Bluefy throughput. After saving any active take, reload the page
and confirm the startup log says `1.0.0-shell119-chakshu`; keep firmware 1243.
Compare an audio-only take with a video take and retain the new slow-audio
snapshot if either falls behind. Its observed link timeout, capture counters,
notification rejects and camera activity will narrow the remaining cause.
