# Pendant audio pipeline audit — 14 September 2026

The earlier pipeline applied a firmware high-pass filter, optional automatic
RNNoise on the upload body, and cloud silence cropping. Those automatic
transformations are removed. New pendant recordings now follow one path:
unfiltered microphone PCM → BLE ADPCM → one app decode → original PCM journal
and WAV upload → unchanged WAV at ASR.

This is **not lossless microphone capture**. The firmware still converts 32-bit
I2S slots to PCM16 and uses lossy IMA ADPCM for Bluetooth. After that single
decode, new upload and ASR bodies preserve every stored sample.

## Transformation map

| Boundary / owner | Before this change | Current behavior / verification |
| --- | --- | --- |
| C3/S3 I2S capture, `acquireAudioFrame` | Slot conversion, then a 70 Hz high-pass with persistent state; first sample replaced with zero | Slot conversion only. Removed filter and its state, including recovery/reset hooks. Native tests run the real function for both materialized targets and preserve all 65,536 PCM16 values, nonzero low slot bits, odd partial reads, generation changes and driver restart. |
| Firmware transport and recovery | 800 samples encoded into 404-byte IMA ADPCM frames; recovery stores those compressed frames | Unchanged codec, pacing, packet format and bounded recovery. Compression is lossy. No added denoiser, gate, gain or VAD. |
| App BLE ingress, `audio-codec-v3.js` | Reassemble each compressed frame, decode to 1,600 PCM bytes, expose four packet views | Decode once. Generated frames travel through production packet views, real IndexedDB and browser playback; stored integer samples must match exactly. |
| Journal / export, `audio-store.js` | Persist decoded PCM, compact 30-second windows; insert explicit silence for unrecovered frame positions | Preserve that timeline and its missing-frame diagnostics. Reject invalid PCM sample/frame lengths before compaction deletes packets. WAV lengths and view offsets are checked. |
| Cloud upload selection, `synap-backend.js` | RNNoise Worker at 48 kHz with up/down sampling, latency compensation and a bounded correction to the source | New uploads select the journal WAV itself. No automatic Worker, filtering, normalization or resampling. Validate and freeze exact upload bytes before sending. Metadata records `uploadAudioProcessing: none`. |
| Old app compatibility, `audio-enhancement.js` | `prepareForUpload` could start a model | The entry point now returns the original Blob without DSP. Only an explicit user request can generate a separate enhancement preview/export. |
| Cloud intake and stored retries | Raw bytes were accepted without complete PCM validation | Validate before storage/model calls, verify declared SHA-256 and preserve the immutable accepted source. Previously stored malformed audio fails before another ASR request. |
| Encrypted cloud source | Envelope encryption and later decryption | No audio transformation. Route regression checks the model request against the exact uploaded WAV after encrypted persistence. |
| ASR, `transcribe.ts` | Trim sufficiently long silent edges, then adjust returned offsets | Send the complete source WAV unchanged on the first attempt and every fallback/review. Word offsets use only the segment's original position. A read-only exact-zero check avoids hallucinating text for wholly zero-filled windows; even ±1 PCM samples remain eligible for ASR. |
| Cloud audio export, `source.ts` | Reconstruct positions from timestamp-to-byte rounding | Strict PCM parsing and sample-aligned positions. Fractional legacy times can no longer insert a half sample. Timeline gaps remain explicit. |
| Speaker identity branch | Extract short non-overlapping speech excerpts, convert PCM to model floats and normalize embedding vectors | Remains a separate metadata branch. `speaker-service/app.py` returns embeddings, never a replacement audio file. It cannot rewrite journal, upload or playback audio. |
| Browser playback / quality observation | Native WAV playback and read-only signal statistics | No custom playback DSP. Integer PCM must match; the native decoder is checked within one PCM16 step to allow float normalization differences. |

## Why BLE compression remains

At 16 kHz mono PCM16, payload is 32,000 bytes/s. The existing codec uses
404 bytes per 50 ms frame, or 8,080 bytes/s, before packet headers. Changing to
raw PCM would nearly quadruple notification traffic and recovery memory.
The current recovery allocation is up to 600 compressed frames on an S3 with
PSRAM and 100 on sufficiently provisioned internal RAM, including the C3.
The codec also resets its quantizer state per frame; it introduces quantization
error and is not ruled out as a contributor to perceptual quality in other takes.

This release removes stacked preprocessing without simultaneously changing
radio throughput, recovery capacity or the wire protocol. A lossless transport
change needs a separate throughput and recording comparison on physical C3/S3
devices. No physical Bluetooth throughput result is claimed here.

## Existing recordings and other capture paths

- A previously persisted `transcriptionBlob` is reused, even if an older release
  enhanced it. A timed-out request might already be accepted remotely; replacing
  its bytes would conflict with the immutable source hash. No old recording is
  silently overwritten, reprocessed, renamed or deleted.
- Existing firmware keeps its previous capture behavior until it is updated.
  The PWA cannot undo filtering already applied on a pendant.
- Manual enhancement creates a separate copy and is outside the canonical
  recording/upload path. It does not replace source or automatically retrain a
  voice profile.
- Desktop meeting capture is a separate system-audio-plus-microphone mixer. Its
  browser echo cancellation, noise suppression, gain and resampling remain in
  `desktop-capture.js`; they are not in the C3/S3 path. Voice-profile enrollment
  separately requests browser processing disabled.

## Incident evidence and remaining checks

The supplied WAV had one leading zero byte before otherwise complete PCM. Its
repaired payload matches all 384 codec frames exactly. See the
[recording investigation](ROBOTIC_AUDIO_2026-09-14.md). This confirms a sample
alignment failure, but does not identify where that byte was inserted or prove
that a filter/denoiser caused it.

Removing the high-pass exposes microphone DC and low-frequency rumble. Quiet
input remains quiet; software cannot recover a missing physical microphone
signal. The remaining device check is a short recording after updating both
the app and pendant, comparing in-app playback with the exported original WAV,
then a longer continuity run with the diagnostic log. Unit, browser and firmware
build tests establish software contracts, not subjective audio quality or
physical radio/power stability.
