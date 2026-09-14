# Robotic recording investigation — 14 September 2026

The supplied 19.2-second recording contains one extra zero byte at the start of
its PCM payload. This shifts every 16-bit sample by one byte. Removing that byte
and correcting the two WAV length fields restores exactly 307,200 samples.
All 384 recovered frames round-trip through the production ADPCM encoder and
decoder byte for byte. There are no missing or digitally silent frames in this
specific take. The recovered signal remains quiet: RMS 133.59 on the PCM16
scale, peak 1,718. Recovery does not add gain or denoise the source.

| Measurement | Supplied file | Repaired copy |
| --- | --- | --- |
| File bytes | 614,445 | 614,444 |
| Declared PCM bytes | 614,401 (odd) | 614,400 |
| First samples | 9472, 8704, 9472, 8704 | 37, 34, 37, 34 |
| RMS | 12,297.71 | 133.59 |
| Sample difference RMS | 9,604.96 | 26.74 |
| Exact codec frames after realignment | — | 384 of 384 |

PCM16 mono requires two-byte sample alignment; padding metadata chunks does not
permit a half sample inside the audio data. See Microsoft's
[WAVEFORMATEX block-alignment contract](https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex).

## What is confirmed and what remains unknown

The malformed file and recoverable PCM alignment are confirmed. The point at
which its leading byte was inserted is **not established** from the attachment.
Current capture assembly produces 1,600-byte frames. The IndexedDB write probe
adds and deletes its temporary one-byte rows in the same transaction; the new
browser regression verifies that those rows do not enter captured audio.

Cloud reconstruction did independently round timestamps to individual bytes.
For example, a legacy segment starting at 0.02 ms would cause a one-byte leading
gap. It now rounds to samples before converting to bytes. Current upload routes
already require integer milliseconds, so this reproduction does not prove that
the supplied recording took that path.

No microphone filter, gain, ADPCM wire format or firmware version is changed by
this fix. This evidence does not establish a physical cause for earlier BLE
disconnects or the different silence in the September 13 recordings.

## Changes and regression coverage

- Reject split PCM samples at WAV construction and invalid frames before
  compaction can delete raw packets. Stored corrupt PCM is retained.
- Validate source WAVs, persisted retry bodies and enhancement output before
  uploading: exact container and chunk lengths, single format/data chunks,
  metadata padding, 16 kHz mono PCM16 format and complete samples. Browser
  validation reads headers only, with a bounded chunk count.
- Apply the same strict parser to cloud upload and source reconstruction.
  Malformed uploads return a non-retryable `invalid_audio` response before
  storage or a model call, instead of a downstream Gemini argument error.
  Already-stored malformed windows also stop before model retry, preserving the
  encrypted source for explicit recovery.
- Generate the reported 614,401-byte corruption shape in tests. No private
  recording is checked into this repository. Browser coverage runs compressed
  notifications through IndexedDB, WAV export and native audio decoding and
  compares every sample to its expected value.
- Backend unit tests and the disposable emulator suite now block outbound
  sockets; real cloud services must be mocked.

`node tools/repair-pcm-alignment.cjs input.wav separate-output.wav` creates a
copy only for this exact file shape and only when every recovered frame matches
the codec. It refuses uncertain data and refuses to overwrite existing files.
It is an explicit recovery utility, not automatic mutation of saved recordings.

Physical C3/S3 recording and in-app playback still require a device test. A new
short recording plus the app diagnostic log can establish whether a remaining
problem originates before storage or during export.
