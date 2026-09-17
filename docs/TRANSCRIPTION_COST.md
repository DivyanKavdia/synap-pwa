# Transcription input and cost controls

Managed standalone audio now uses a pitch-preserving 1.5× ASR copy. A 30-second
window becomes approximately 20 seconds at the same 16 kHz mono PCM16 format.
The browser uploads and retains the original bytes; after decrypting a window,
the backend runs FFmpeg `atempo=1.5` through stdin/stdout immediately before
submitting to Gemini. It writes no plaintext temporary files and never replaces
the encrypted source. This optimizes provider input, not phone upload bandwidth.
No microphone, Bluetooth, camera, SD or local voice firmware changes are needed.

## Quality and bounds

- Keep windows shorter than five seconds at normal speed; never discard tails.
  This protects short final utterances while retaining acceleration on full windows.
- Validate the entire WAV before preparation and the derived duration afterward.
- Bound the subprocess to 10 seconds, one filter thread and a 2 MB input limit.
  Abort cancels it; conversion failure uses the original recording.
- If accelerated recognition returns explicitly empty text, the existing single
  empty-result retry uses original 1× audio with automatic language detection.
  Missing/incomplete output also gets one original-audio pass with provider-default
  settings. A 400 rejection of accelerated input gets this fallback after optional
  settings are removed. Rate limits, authorization failures and service outages
  never trigger extra original-audio submissions. A failed fallback remains an
  error, not evidence of silence.
- Map each word to `window start + ASR offset × speed`, bounded to source duration.
  On a normal-speed fallback use factor 1. Speaker extraction, navigation and
  summaries therefore continue to refer to the original timeline.
- Retain the text-first ASR policy and only accept complete, agreeing annotations.
  Keep the existing summary models and grounding checks.
- `SYNAP_TRANSCRIPTION_SPEED=1` disables acceleration for a reversible rollout.
  Completed transcripts stay cached; changing speed does not re-bill old windows.

## What savings mean

1.5× reduces the duration of a single audio input by approximately 33.3%.
It does **not** imply a 33.3% reduction in total charges: recognized text still has
the same output tokens, annotations may need a second pass, retries add input,
and summaries, embeddings and infrastructure have their own costs.

Each completed window stores source/prepared duration, final speed/fallback,
submitted audio milliseconds and HTTP attempt count. The attempt hook runs at
every provider submission, including retries and annotation passes. Numeric-only
submission logs also cover attempts in jobs that ultimately fail. Existing Gemini
usage logs retain provider token counters. Neither log includes audio, transcript
text or recording IDs. A timed-out request may still have been billed.

The phone replaces each window's usage checkpoint rather than accumulating PUT
responses, so duplicate successful upload responses do not multiply displayed
usage. The UI labels this as usage for completed windows; failed jobs and
concurrent discarded results can add usage. It is not an account billing ledger.

The existing rupee calculation uses a 9 September historical blended-rate and
Flash-Lite snapshot, while current summaries use Flash. It is now explicitly
labelled a historical illustration, and no blanket speed discount is applied.
Do not promote it to a current bill until current model-specific input/output
rates, provider counters and failed-job usage are reconciled.

## Reference repository assessment

Reviewed [ScalabeMeetingTranscribe at fb33a87](https://github.com/myExperimentsWithTruth/ScalabeMeetingTranscribe/tree/fb33a875b4b025c6ef49e76f46c14fb7d72c3411).
It is an MIT-licensed Python meeting pipeline, not a cost-governance framework.
Its applicable ideas are FFmpeg tempo adjustment, source-time correction,
chronological chunk assembly, cached completed chunks and bounded retry/backoff.
Synap already implements durable 30-second windows, completed-result reuse,
retry backoff and bounded processing concurrency; those remain in place.

This implementation uses the atempo/time-mapping approach independently without
importing its Python application. We do not adopt its 2× default, long chunks,
short-tail deletion, model choices or self-reported price/accuracy claims.
Photos, video and their paired soundtracks remain device-only and never enter
this provider pipeline. Only standalone audio is eligible.

## Verification and practical limit

Automated checks use real FFmpeg to verify duration, stable pitch, tail retention
and byte-for-byte original preservation. Mocked provider checks cover source-time
mapping, empty-result fallback, retry/annotation accounting, digital silence and
completed-result reuse. These are correctness checks, not measured recognition
accuracy. Compare representative Hindi/English and quiet/noisy recordings at 1×
and 1.5× for word errors, names, numbers, final corrections and summary evidence
before claiming an accuracy or monetary improvement.
