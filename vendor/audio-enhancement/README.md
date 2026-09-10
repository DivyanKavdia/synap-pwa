# Local speech enhancement model

`rnnoise-sync.js` is an **unmodified** copy of `dist/rnnoise-sync.js` from
[`@jitsi/rnnoise-wasm` 0.2.1](https://www.npmjs.com/package/@jitsi/rnnoise-wasm/v/0.2.1).
It contains the RNNoise 0.2 default noise suppression model and its WebAssembly
runtime. No model weights or audio are fetched from a third-party service.

The [Jitsi README](https://github.com/jitsi/rnnoise-wasm/tree/cb529a59a8478fe604e57986fc96afdaecfa6fb7)
explicitly distinguishes this suppression build from its separate, older RNNoise
0.1 async binary used for noise detection. Only the suppression build is shipped.

| Provenance | Value |
| --- | --- |
| Jitsi source commit | `cb529a59a8478fe604e57986fc96afdaecfa6fb7` |
| RNNoise source submodule | `372f7b4b76cde4ca1ec4605353dd17898a99de38` |
| RNNoise source model version | `0b50c45` |
| File size | 1,933,102 bytes, including embedded WASM |
| SHA-256 of `rnnoise-sync.js` | `05a553f523d59502d133a6d05dbf1878137c9e7bcff06edf5561f7001b62f95f` |
| npm tarball SHA-512 integrity | `sha512-iEj77www43pS2Yq+cfLZb+hFuI7L5ccisBzzPMcOjjLsG4/LAlkD1CY58/8gc84nHdLBGmD/OPIWGnvYnXvB0A==` |

The npm file was verified byte-for-byte against that Jitsi source commit.
`LICENSE-JITSI.txt` contains Jitsi's Apache-2.0 license and its retained original
MIT notice. `LICENSE-RNNOISE.txt` contains the RNNoise BSD-3-Clause license,
including the copyright notices applying to its code and bundled model.
Keep both notices with the distributed app.

## Pipeline and resource limits

`window.SynapAudioEnhancement.enhance(blob, {signal, onProgress})` returns a new
16-bit mono 16 kHz WAV Blob. It never writes IndexedDB, uploads audio, invokes a
transcription provider, or mutates the source Blob. UI playback and export can
use this optional copy; transcripts and source recordings stay intact.

- Input: a saved mono PCM16 little-endian RIFF/WAV at 16 or 48 kHz, up to 20 minutes.
  Compressed, float, stereo and other sample rates receive an explicit error.
- One task runs at a time. The cancel signal immediately terminates its dedicated
  Worker and releases partial output. Completion and failures also terminate it.
- RNNoise runs at 48 kHz in 480-sample frames. The 16 kHz input uses a windowed-sinc
  interpolator. A 97-tap anti-alias filter converts the result back to 16 kHz.
  Resampling cannot recover frequencies missing from the original recording.
- RNNoise state persists for the full recording, including across one-second
  input reads. Its two-frame delay (960 samples at 48 kHz in this pinned build)
  is removed, and the final frames are flushed. Original 16 kHz sample counts and
  timestamps are preserved exactly; 48 kHz sources round up to the next 16 kHz sample.
- No full-file floating-point decode is allocated. Working buffers remain bounded
  (one second of input, one second of PCM output, filters and a small ring buffer).
  The pinned WASM starts with 16 MiB memory. Generated PCM accumulates at 32 KB/s
  until the final Blob: at the 20-minute limit the copy is 38.4 MB. Browser Blob
  implementation, model compilation, the retained original and the final export
  can add copies/overhead; this is not a total browser memory guarantee.
- Progress uses `{stage, progress, processedSeconds, durationSeconds}`. `stage` is
  `loading`, `processing` or `complete`; progress is a fraction from 0 to 1.
  `supported()`, `busy()` and `limits` let the UI offer compatible controls.
- App installation caches the same-origin script, Worker and model for offline
  operation. Run only on explicit user request after recording/capture has stopped.

RNNoise estimates speech-preserving spectral gains; it does not generate words.
Noise reduction may soften quiet speech, distant speakers, music or other useful
sounds. It cannot fix microphone clipping, packet loss, or overlapping speakers.
Keep Original/Enhanced comparison available. Noise suppression is not evidence of
better transcription accuracy; real pendant speech and listening tests are still
needed before changing any automatic processing defaults.

## Verification

`node --test tests/audio-enhancement.cjs` runs the actual bundled model in an
isolated Worker adapter with generated audio, checks finite output, suppression,
sample counts, partial frames, cancellation, original preservation and invalid inputs.
`node tools/audio-enhancement-smoke.cjs` runs the public API in Chromium with
all non-local browser requests blocked. See that tool for runtime configuration.

Primary references: [RNNoise source and license](https://github.com/xiph/rnnoise/tree/372f7b4b76cde4ca1ec4605353dd17898a99de38),
[pinned frame processing](https://github.com/xiph/rnnoise/blob/372f7b4b76cde4ca1ec4605353dd17898a99de38/src/denoise.c),
[Jitsi build](https://github.com/jitsi/rnnoise-wasm/blob/cb529a59a8478fe604e57986fc96afdaecfa6fb7/build.sh),
[RNNoise design by its author](https://jmvalin.ca/demo/rnnoise/).
