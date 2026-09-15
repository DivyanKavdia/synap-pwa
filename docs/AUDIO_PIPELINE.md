# Audio pipeline and diagnostics

## Source-preserving capture

The pendant path is microphone → PCM16 → Bluetooth → local PCM journal → original WAV upload → encrypted cloud source → the same stored WAV to ASR. Entirely zero windows retain their source and get an empty transcript without a model call. Optional noise reduction produces a preview/export copy; it is not automatically selected for upload.

| Stage              | Contract                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| C3/S3 microphone   | Signed 32-bit INMP441 I2S slots convert with `raw >> 16`; no firmware gain, denoising, high-pass filter or silence gate                            |
| Chakshu microphone | Onboard PDM provides PCM16; voice inference uses a separate copy                                                                                   |
| Bluetooth          | Prefer PCM16 v2; use independent IMA ADPCM v3 frames on constrained supported links                                                                |
| Recovery buffer    | Retain original PCM in volatile memory; encode only when the resumed link requires it                                                              |
| Journal/playback   | Preserve received samples, transport counts and timeline gaps                                                                                      |
| Cloud upload/retry | Persist the exact request body; new original-source bodies are marked `source-pcm-v1`                                                              |
| ASR                | Send every nonzero stored WAV unchanged, including quiet samples and silent boundaries; skip only an entirely zero window                          |
| Speaker identity   | Derive speaker-specific excerpts for embeddings without replacing source or ASR audio                                                              |
| Desktop capture    | Mix/resample browser input; noise suppression and gain control are disabled, echo cancellation remains to avoid recapturing meeting speaker output |

Voice enrollment requests suppression, gain and echo cancellation off. Microphone and host driver processing are outside the firmware DSP path. PCM16 is lossless from conversion onward for received uncompressed frames; ADPCM is lossy. INMP441 conversion discards lower significant bits and is not raw 24-bit recording.

## Transport and recovery budgets

All pendant formats produce 800 mono samples per 50 ms frame at 16 kHz. Control protocol is v2; transport choice is reported in status and saved with frame counts.

| Resource                       | Contract                                                                |
| ------------------------------ | ----------------------------------------------------------------------- |
| PCM source rate                | 256 kb/s before Bluetooth overhead                                      |
| PCM at MTU 185 / 247 / 517     | 10 / 7 / 4 notifications per frame                                      |
| Fallback at MTU 32–184         | 404-byte ADPCM frames, 64.64 kb/s before overhead                       |
| MTU below 32                   | Cannot start audio streaming                                            |
| Recovery with sufficient PSRAM | Up to 600 frames / 30 seconds, approximately 965 KB                     |
| Internal-memory recovery       | Conditional allocation of 25 frames / 1.25 seconds, approximately 40 KB |
| No adequate allocation         | Recovery unavailable; ordinary audio remains usable                     |

The PCM threshold is a fragmentation policy, not a measured guarantee of radio throughput. Normal pacing is 45 ms/frame; recovery catch-up uses 30 ms only with at most five fragments/frame. Selection occurs at START/RESUME and can change on reconnect with a different MTU. A saved take can therefore contain both formats.

Recovery is negotiated with an owner token, expires after 60 seconds and has a bounded STOP drain. Power loss, overflow, sleep or a closed/reloaded page can lose audio. Bluefy/iOS can suspend a web page without a Bluetooth disconnect; a short pendant buffer cannot preserve an unlimited background session. See [background recording](BACKGROUND_RECORDING.md) and [recording lifecycle](RECORDING_LIFECYCLE.md).

## Ownership and persistence

`recording/bluetooth-session.js` serializes native requests and rejects stale generations. A timed-out native operation retains its queue position until it settles. `app.js` decides whether the timeout requires a disconnect. START rechecks the recording owner and Stop intent immediately before sending, so a queued START cannot execute after cancellation.

Stop has one drain operation per recording/connection, including a click arriving
during reconnect. Once the recovery service acknowledges draining for the armed
token, the PWA polls status without repeating STOP. A two-byte command echo from
older Chakshu firmware triggers one GET_STATUS/read repair; it never counts as an
idle acknowledgement. The journal stays open until real idle/error handling or
the existing bounded failure path seals it.

`audio-store.js` journals packets before compaction, preserves missing frames as explicit time gaps, and owns close/delete barriers. Concurrent close calls coalesce; failed saves retain recoverable data. A late packet before the recording origin cannot replace frame zero. The storage write probe creates and deletes its temporary rows in one transaction. Connecting and updating firmware do not depend on recording storage being writable.

Managed jobs are pinned to their capture account and abort on account changes. Legacy unowned recordings are assigned on first managed sync. Local browser storage itself is not an operating-system user boundary. Cloud restore preserves existing local recordings and never invents playable audio. Each window's source and processing result survive retries; final processing requires every expected window, not merely the expected count. Derived memory and its ready checkpoint publish atomically under a worker lease.

Chakshu video frames and linked audio have separate storage and IDs. Only the soundtrack enters transcription. Vision requests receive selected JPEG frames, never a video file or audio stream.

## WAV integrity and explicit repair

WAV construction, browser upload and backend ingestion validate container/chunk sizes, padding, single format/data chunks, 16 kHz mono PCM16 and whole samples. Timestamp conversion rounds to samples before converting to bytes. Invalid frames fail before compaction can discard raw data. Malformed uploads return `invalid_audio` before storage/model work; existing corrupt sources are retained for explicit recovery.

A historical malformed export had one leading zero byte and an odd PCM byte length, shifting every 16-bit sample. This is a different failure from radio packet loss or quiet microphone input. The precise insertion point was not established. The repair utility accepts only that shape when every recovered frame matches the codec:

```sh
node tools/repair-pcm-alignment.cjs input.wav separate-output.wav
```

It refuses uncertain data and existing output files. It creates a separate copy without gain or denoising. It never mutates saved recordings automatically. Tests use generated corruption rather than private recordings. Pre-upgrade cached upload bodies also remain unchanged because the cloud may already have accepted them; they are not relabelled as original-source uploads.

## Reading a diagnostic log

| Evidence                                                                          | Interpretation and next check                                                                                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App requested GATT disconnect` followed by `origin: app`                         | Read the preceding setup/command error; this is a deliberate client disconnect                                                                           |
| STREAMING with MTU23, zero chunks/payload, then idle at MTU517 on a later attempt | An abandoned buffered session or incomplete negotiation can block setup; with no recording owner, STOP must normalize idle before retrying the handshake |
| Valid idle but invalid START transport                                            | Preserve the connection for settings/OTA; require supported negotiated transport before accepting audio                                                  |
| Disconnected with peripheral reason/reset or uptime restart                       | Compare firmware reason, power/reset evidence, captured frames and notification failures                                                                 |
| No disconnect but no incoming audio while the page is hidden                      | Browser suspension is possible; compare visibility and replay before treating it as a radio fault                                                        |
| Missing frame counts                                                              | Actual timeline gaps, distinct from received silence; missing speech is not reconstructable                                                              |
| Repeated two-byte status reads after STOP on build1231                            | The writable control characteristic retained command bytes during drain; update Chakshu firmware. The PWA requests a fresh status while preserving the journal |
| Repeated drain waits with few complete frames                                    | Compare received packet/frame counts and firmware notification rejections; a live radio or STREAMING status alone does not prove useful audio delivery |
| Complete frames with very small sample values                                     | Check microphone input/wiring/acoustics; do not label it packet loss                                                                                     |
| Odd PCM data length or strict WAV failure                                         | Preserve the source and inspect alignment; do not repeatedly retry ASR                                                                                   |

Settings diagnostics accept firmware packet v1 and v2. V2 preserves disconnect count/reason/time and notification failure counters. Flags `0x40` and `0x80` identify unconditioned capture and selected PCM transport. Notification rejection measures a failed local stack submission, not necessarily lost phone audio because a retry can succeed. Copy or download the full app log with installed build, target and visibility events.

## Verification boundary

Native tests cover capture conversion, partial reads, cancellation, MTUs, codec bytes, replay ownership, buffering and board battery/power policies. Browser fixtures carry packets through IndexedDB, compaction, WAV export and native playback, and exercise cancelled START, orphan STREAMING recovery and account changes. Backend tests compare ASR source bytes and reject incomplete windows; disposable emulator tests exercise transactional publication.

For physical acceptance, record each affected device for 10–15 minutes, include quiet speech and brief interruptions, listen to local/cloud-source downloads, and inspect transport, gaps, notification/capture drops and STOP drain. Check Chakshu camera/audio timing separately. Tests and successful compilation cannot certify RF endurance, microphone quality or OS background delivery.
