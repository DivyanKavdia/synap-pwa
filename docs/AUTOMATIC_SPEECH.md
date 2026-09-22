# Automatic speech processing

**Reviewed: 22 September 2026**

Synap can create a locally enhanced speech copy for playback or bounded upload preparation. Enhancement is always derived data; it never replaces the user's original recording.

## Pipeline

```text
source WAV
  → validate PCM16 mono / supported rate
  → dedicated Worker
  → resample to 48 kHz when required
  → RNNoise suppression
  → delay compensation + bounded correction
  → resample to 16 kHz
  → derived WAV
```

The pinned RNNoise runtime and license/provenance details are documented in [the vendor README](../vendor/audio-enhancement/README.md).

## Invariants

- Source Blob/recording stays unchanged.
- Enhancement never writes IndexedDB by itself.
- Enhancement never calls a cloud transcription provider by itself.
- Cancellation terminates the dedicated Worker and discards partial derived output.
- Sample counts/timing are preserved according to the documented resampling contract.
- Noise suppression is not treated as evidence that transcription is more accurate.
- It cannot repair packet loss, clipping, missing speech or overlapping speakers.

## Automatic upload preparation

New cloud windows may pass through the same guarded local preparation path before upload when the source is compatible. The original recording remains the provenance source.

The cloud durable unit remains the recording/segment source window; a prepared inference copy does not become a new user recording.

## Supported limits

The shipped enhancement implementation accepts compatible mono PCM16 WAV input and enforces a bounded duration. RNNoise runs with its own state for the whole derived recording while I/O is processed in bounded chunks.

See `audio-enhancement.js`, `audio-enhancement-worker.js` and tests for the executable limit values. Keeping numeric limits in code prevents this document from becoming a second configuration source.

## Verification

```sh
node --test tests/audio-enhancement.cjs
node tools/audio-enhancement-smoke.cjs
```

Tests cover source preservation, finite output, sample counts, suppression behavior, cancellation and invalid input.
