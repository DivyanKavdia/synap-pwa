# Recording and reconnect

## Ownership and durable audio

`app.js` owns connection and recording state. GATT discovery, reads, writes,
event subscriptions, standby and OTA share one serialized queue. Every queued
operation belongs to a connection/session; stale work is discarded. A caller's
timeout does not free an underlying native operation that is still running.

Startup acquires the app lock, opens the journal and recovers interrupted
recordings. Recording additionally requires a successful storage write check.
Connection and firmware maintenance can remain available when recording storage
needs recovery. Failed historical recovery preserves raw audio and exposes a
targeted Retry while unaffected recordings remain usable.

`recording-bridge.js` alone adopts a pendant-started stream. Incoming audio is
decoded and journaled with sequence continuity; missing frames keep their time
positions as silence. `rolling-transcription.js` closes completed 30-second
processing windows and wakes `SynapProcessingQueue` without replacing its class.
These windows are not separate user recordings.

Rolling compaction requires all 600 frames. A window with absent or incomplete
frames stays in the packet journal so late recovery packets can fill it; moving
into the next window is not proof the earlier window is complete. Late packets
recheck their own window without moving the live window cursor backwards.
Compaction deletes only complete frames represented by its PCM snapshot and
retains partial evidence. Stop is the boundary that seals remaining gaps.

If a take contains audio, entirely missing windows also receive upload jobs so
the backend sees every timeline segment at finalization. Its digital-silence
check avoids sending those windows to Gemini. Empty captures keep their partial
packets without queuing processing. Saved recordings show the missing duration
and percentage in the Library and beside playback; their silent placeholders
preserve timestamps but contain no recoverable speech.

Stop ends microphone capture, drains eligible audio and seals the same journal.
Stop intent survives a transport interruption; reconnect must not issue another
START for a take that is stopping. Notification controls use the same recording
actions and bind each command to its owning client and recording session.

## Recovery limits

| Layer                         | Limit and meaning                                                           |
| ----------------------------- | --------------------------------------------------------------------------- |
| PWA same-page recovery        | Up to five minutes of reconnect attempts for an interrupted take            |
| Firmware disconnect handshake | 60-second bound on negotiated recovery                                      |
| Firmware buffered audio       | Up to 30 seconds in S3 PSRAM; up to 5 seconds with sufficient internal heap |
| Firmware Stop drain           | 35-second absolute bound, including a reconnect during drain                |

The app's retry window is not an audio retention guarantee. Buffer capacity is
reported by firmware and depends on allocation. Overflow, sleep, power loss,
reload and browser suspension have different loss boundaries. The ring is
volatile and does not record to flash.

Recovery is negotiated with an ephemeral session token on characteristic `4f`.
RESUME includes the last complete frame received by the same journal. Token
matching binds recovery to that take; it is not Bluetooth authentication. See
the [firmware recovery contract](https://github.com/DivyanKavdia/synap-firmware/blob/346b819caf89d3ed3ac2d401dce939237f9c5390/docs/DISCONNECT_RECOVERY.md)
for the packet layout and acknowledgement rules.

## Visibility, sleep and reload

Visibility gates new automatic connection attempts. It does not cancel a
handshake already in progress or demand disconnection of a live recording.
Foreground audio-stall detection owns transport recovery; a slow status read
alone does not disconnect a recording that is still receiving audio.

Manual disconnect, disabled reconnect and intentional sleep suppress automatic
attempts. The sleep guard retains the user's preference independently of that
temporary suppression. A successful live handshake clears sleep suppression.
When available, permitted-device restoration and advertisements can recover a
known pendant without reopening the chooser. Unsupported browsers need a user
Connect action. Reload does not start a new recording.

Wake Lock and notifications cannot prevent OS Bluetooth suspension. Native iOS
recording controls and Dynamic Island require the native integration described
in [recording notifications](RECORDING_NOTIFICATIONS.md).

## Diagnose an interruption

Download the log from Settings → Support → Diagnostics soon after the failure.
Check the recorded disconnect origin, visibility, last-audio age, firmware
target/build, reset reason and capture/notification-drop counters. An origin of
`browser-or-peripheral` means the app did not request the disconnect; it does not
identify the radio termination reason.

`npm run test:browser -- audio-storage controls connection recording-notifications` exercises
real page/worker/storage behavior with a simulated pendant. Physical device
testing is still needed for RF loss, battery/power behavior, OS notifications,
long capture and OTA. Firmware's S3/C3 gestures differ; the current mapping is
linked from the project README.

The audio-storage suite uses generated PCM and real IndexedDB to reproduce a
gap across a 30-second boundary, replay missing frames, verify every exported
sample, and check the unrecovered-gap warning and silent-window upload jobs.

## Captured signal health

Quality checks preserve every PCM sample. Live volume and clipping warnings use the most recent three seconds, so a loud startup transient cannot hide later quiet capture. Three continuous seconds at the digital floor (absolute PCM16 value at most 2) produces a conditional microphone warning; it does not imply lost BLE packets, stop recording, or gate speech. The longest interval is retained in recording metadata, the saved recording, and the bounded diagnostic log. Live warnings clear when the signal returns. Packet-gap warnings still depend only on absent/incomplete frames.

For repeated S3 or C3 disconnects, retain the Settings → Support → Diagnostics log after reconnecting and stopping, plus the installed firmware build. The log distinguishes app-requested disconnects, peripheral link reasons and reboot evidence. A WAV cannot establish a radio, power, wiring or microphone-driver root cause.

Automatic firmware discovery checks recording eligibility again when each queued Bluetooth operation is about to start. Starting capture during a pending check defers the remaining service, characteristic, subscription and value reads until idle. An already-running native request must finish; it is never cancelled by disconnecting the recording. Explicit firmware transfers retain their existing Stop/save flow and transfer lock.
