# Recording and reconnect

## Ownership and durable audio

`app.js` owns connection and recording state. GATT discovery, reads, writes,
event subscriptions, standby and OTA share one serialized queue. Every queued
operation belongs to a connection/session in `recording/bluetooth-session.js`; stale work is discarded. A START waiting behind older work rechecks the recording session and Stop intent immediately before writing. A caller's
timeout does not free an underlying native operation that is still running.
Queue wait and native execution each have a separate 3.5-second deadline. An
operation that reaches the front of the queue receives its full execution time.
Expired queued commands never run later. A blocked queue records the active
operation's name; if capture has ended, its timeout disconnects the stuck link.

Startup acquires the app lock, opens the journal and recovers interrupted
recordings. Recording additionally requires a successful storage write check.
Connection and firmware maintenance can remain available when recording storage
needs recovery. Failed historical recovery preserves raw audio and exposes a
targeted Retry while unaffected recordings remain usable.

`recording-bridge.js` alone adopts a pendant-started stream. Incoming audio is
decoded and journaled with sequence continuity; missing frames keep their time
positions as silence. `audio-store.js` closes completed 30-second processing
windows; explicit callbacks from `recording/journal.js` wake `SynapProcessingQueue`.
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
| Firmware buffered audio       | Up to 30 seconds in S3 PSRAM; up to 1.25 seconds with sufficient internal heap |
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

## Passive Bluetooth work during recovery

The app-owned shared service gates optional work before enqueueing and again before the native call starts. Battery/power setup, passive diagnostics and other consumers of that service cannot start requests during capture, startup, Stop/save, firmware transfer or recording reconnect. Required identity, control and recovery operations retain the recorder queue. Existing notifications remain attached. Event setup defers without a retry loop and resumes when capture has been saved and the connection becomes eligible. This removes optional traffic from the reconnect handshake; it does not prove a physical link-loss cause or replace device diagnostics.

## Journal lifecycle ownership

`DKAudioStore` receives capture features through explicit constructor options.
Each pendant journal owns its own `RecordingTimeline`; desktop capture uses
logical sequences without uint16 normalization. An old transport packet preceding
the journal origin is ignored instead of overwriting frame zero.

Close marks the journal unavailable to new appends synchronously, waits for
rolling work, then seals. Concurrent close callers share one operation. A failed
close retains its timeline and packets for retry; successful close releases the
timeline. Deletion waits for rolling work and queued writes before removing rows,
so those writes cannot recreate deleted audio afterward.


## Missing delivery and bounded Stop

The elapsed timer measures time since recording was confirmed; received duration measures complete PCM frames. A connected radio with no complete frames is shown as waiting, not as successful audio capture. After four seconds without complete frames in the foreground, the recorder makes one notification/replay repair attempt per recording. It keeps the same journal and never issues another START. Stop or a changed connection cancels queued repair work. A diagnostic snapshot after the attempt records firmware capture and notify counters if available. Healthy recording is not polled.

Every Stop, including a pendant-initiated drain, has one recording-owned watchdog. Reconnect cannot reset its deadline. Complete frames extend the progress window; status notifications or partial packets alone do not. After eight seconds without complete-frame progress, or 35 seconds total, the app disconnects if necessary and seals the original journal as `stop-unconfirmed`. Received packets remain available; missing audio is not synthesized as recovered speech. Normal acknowledged drain still saves as `normal`. While finishing, the header shows Finishing and received duration; it cannot imply Ready while the pendant may still stream.

Browser coverage: `node tools/audio-stall-smoke.cjs` exercises notification repair, zero received audio, pendant-initiated Stop and link loss during Stop using the real recorder and IndexedDB journal. Native watchdog tests exercise progress, the absolute deadline and recording ownership. Physical pendant validation is required for microphone capture and sustained BLE throughput.

A pending notification/replay repair cannot suspend the foreground missing-audio deadline. After twelve seconds without a complete frame and the foreground grace period, Stop starts even if repair is still pending. Queued repair work loses ownership, while the Stop watchdog handles any blocked native Bluetooth request. Delayed repair completion cannot restart the take.

Partial PCM and compressed frames expire after a gap without a new fragment,
rather than a fixed interval from the first fragment. Congestion can take longer
than 900 ms to deliver one PCM frame; continuing fragments must remain available
for assembly. Duplicate fragments do not renew the deadline. The browser test
delivers two frames in four seconds and verifies every sample in the saved WAV.

After ten seconds in the foreground, a stream receiving less than half the
elapsed duration also records one firmware diagnostic snapshot, even when some
complete frames keep arriving. The log includes received/elapsed time, packet
statistics and negotiated transport settings. It does not replay or interrupt
that progressing stream. The snapshot helps distinguish capture failure,
notification congestion and browser-side packet loss on the physical device.

Service and characteristic discovery have a ten-second native deadline; control
reads and writes retain 3.5 seconds. A queued Start respects the longer deadline
of discovery already running, then gets its own command deadline. A true native
timeout retains queue ownership until the operation settles or the connection
resets. This accommodates slow Bluetooth bridges without overlapping ATT work.

App update detection compares the loaded shell revision as well as Bluetooth
compatibility. A newer shell shows the reload notice even when the audio protocol
is unchanged. Reload remains disabled until the current take is safely saved.
