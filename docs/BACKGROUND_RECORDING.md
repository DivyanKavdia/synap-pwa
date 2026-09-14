# Background recording on iPhone

Synap's browser recorder cannot guarantee continuous capture when iOS suspends
Bluefy. These changes improve storage, short-gap recovery and reporting; they do
not turn the web page into a native background recorder.

## What was wrong

The clock showed wall time even when no audio arrived. The missing-audio watchdog
only ran while the page was visible. Storage also depended on a 100 ms timer,
which can be delayed while callbacks continue to arrive. Finally, recovery only
handled an actual BLE disconnect. If Bluefy retained the native connection but
stopped delivering notifications, returning to the page did not replay the
pendant's retained audio.

## Current behavior

| Situation | App behavior |
| --- | --- |
| Background packets keep arriving | Store them normally. Flush every 64 packets even if the periodic timer does not run. |
| Page is hidden or frozen | Immediately request a flush of received packets. Keep capture and the connection running. |
| Complete audio stops arriving | The received-audio clock stops advancing. Show **Waiting / No audio arriving** and disable unsupported moment marking. |
| A healthy page returns | Keep its existing subscriptions; no extra GATT traffic. |
| A page returns after missing packets, with BLE still connected | Restore audio notifications once and request acknowledged replay from the last complete frame before the gap. |
| BLE actually disconnected | Use the existing session-bound RESUME handshake and the same journal. |
| Missing samples aged out | Preserve explicit timeline gaps. Received and replayed PCM samples remain unchanged. |
| Delivery was absent for an ambiguous uint16 half-cycle (about 27 minutes) | Save the received take and require a new start, rather than misinterpreting wrapped sequence numbers. |

The on-screen clock is **audio received**, not the recording's wall-clock span.
The saved WAV and transcript timeline continue to preserve known missing-frame
positions. A valid frame containing silence still counts as received audio;
signal loudness does not determine connection health.

The connected replay extension is optional and backward compatible. Its wire
format is documented in the firmware repository's
[disconnect recovery guide](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/DISCONNECT_RECOVERY.md).
The app checks the capability bit and a changing acknowledgement, plus recording
and connection ownership. Stop, a new recording or a replaced connection cancels
stale recovery work. Foreground replay never issues START or disconnects a healthy
link. The duplicate window covers the pendant's full replay capacity.

Buffer limits remain **1.25 seconds on C3**, and **30 seconds on S3 with PSRAM**.
These are volatile rolling buffers, not a recording archive. A long suspension
cannot be repaired from them. Returning near the C3 limit may already be too late
because notification setup and replay also take time.

## Bluefy setup and the platform boundary

Bluefy's publisher lists an **Allowed BLE peripheral manager** for background
connections, plus a screen-dimming API. Allow the pendant there when testing.
Synap's Keep screen awake option uses the Bluefy API when available and restores
dimming afterward. This handles automatic screen lock, not switching to another
app. [Bluefy release notes](https://apps.apple.com/hk/app/bluefy-web-ble-browser/id1492822055).

iOS background Bluetooth support belongs to the native application. Apple
documents `bluetooth-central`, event-driven wakeups and state restoration; the
web page cannot add those capabilities to Bluefy or prevent its suspension.
[Apple Core Bluetooth background processing](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html).

For dependable recording while using other iPhone apps, a Synap iOS recorder must
own CoreBluetooth notifications and write audio to files independently of its web
view. It needs native recording/session restoration, durable sequence checkpoints
and an upload queue. The existing web UI can remain a presentation layer; merely
wrapping it in a web view would leave this failure mode in place. Native capture
still needs physical throughput, interruption and lock-screen acceptance.

## Verification

- Browser tests exercise one recording across healthy background delivery,
  lost callbacks on a retained connection, S3 replay, C3 overflow and old firmware.
  Every received or replayed PCM sample is compared with the generated source.
- Real IndexedDB tests deliver more than the RAM queue capacity while suppressing
  the flush timer and check that packets become durable without manual flushes.
- Native firmware tests cover replay ownership, acknowledgement rollover,
  expired boundaries, subscription refusal, Stop drain and an in-flight send
  completing after the cursor was rewound.
- Lifecycle tests cover delayed visibility events, repeated return events,
  cancellation, a stale counter and Bluefy screen-control cleanup.

These tests simulate callback loss and timer throttling, not iOS scheduling.
On each physical C3/S3 and iPhone combination, compare foreground recording with
1-second, 5-second and 60-second app switches and a screen lock. Inspect received
time, missing frames, replay diagnostics and the original WAV. Keep Synap visible
for recordings that must be complete until native background capture is available.
