# Original audio uploads and speaker continuity

New Synap Cloud processing windows upload the original journal WAV. Automatic
RNNoise, filtering, normalization and resampling are disabled. Cloud ASR
receives the complete uploaded WAV with no silence cropping. Only an entirely
zero-valued window is recognized as digital silence without a model request;
quiet samples are not gated away. See the [pipeline audit](AUDIO_PIPELINE_AUDIT.md).

An explicit **Preview clearer audio** request can still create a separate
RNNoise copy. Its bounded correction preserves the original sign and at least
70% amplitude apart from rounding; it does not replace capture or automatic
upload audio. Synthetic checks do not establish improved transcription accuracy.

Upload bodies are persisted before sending and reused after retry/reload.
Legacy cached bodies retain their exact bytes because an earlier request may
already have been accepted by the cloud. Existing cloud audio is not changed
or automatically retranscribed. A fresh recording uses the original-audio path.

## Rejected transcription requests

Saved language preferences are normalized to supported Gemini language hints;
unknown or mixed-language values use automatic detection. A transcription HTTP
400 gets at most two alternate requests: first automatic language detection
with the requested annotations, then plain verbatim transcription if annotation
options are still rejected. Requests without a language hint skip the first
alternative. Each attempt uses the same audio bytes and `store: false`.

Plain transcription retains the complete text with the original window offset,
marks missing speaker/word annotations as incomplete, and does not start another
annotation repair attempt. Authentication, billing, and non-400 failures do not
trigger option recovery. A persistent rejection still fails honestly; changing
options cannot repair an invalid audio file or unavailable model.

Gemini errors identify the stage and model, and logs record only routing, HTTP
status, fallback choice, audio byte count, and MIME type. Audio is persisted
before rolling ASR begins. **Retry processing** reuses the saved recording and
the existing idempotent upload path; deleting or recording it again is unnecessary.
Provider request tests simulate the reported 400; they do not establish which
argument failed in a particular production recording.

## Speaker attribution

Each ASR request has its own anonymous labels. `spk_1` in one window is not proof
of the same person in the next window. During memory processing, an in-memory
recording matcher compares voice embeddings from Synap's configured speaker
service. It needs at least 2.5 seconds of usable speech, excludes overlapping
voices from identity samples, requires cosine similarity ≥0.80 and a margin
≥0.10, and prevents two labels in the same window mapping to one voice.

The matcher keeps fixed references and is scoped to one recording. Short,
ambiguous or unavailable matches receive distinct window-qualified labels such
as `S2.1`; the system does not guess a person's name. If the speaker service is
not deployed/configured, the distinct-label fallback still works. Existing voice
enrollment remains available for the wearer. Saved manual speaker names retain
their exact labels during later summary rebuilds.

For opt-in named identification across recordings, see
[Remembered speakers](SPEAKER_IDENTIFICATION.md). That separate account-scoped
matcher requires explicit permission and stronger identity thresholds; anonymous
continuity alone is not a name match.

Transcript completeness is checked per window. A partial annotation response
keeps that window's full text without stripping speaker labels from every other
window. The complete source transcript remains authoritative.
A bounded second pass now attempts to repair incomplete annotations without
rewriting the first recognized text; see the remembered-speaker document for
its acceptance rules, latency budget, and limitations.

## Verification

Tests exercise the actual bundled model with generated audio, including quiet
speech-like signals, short tails, silence, cancellation, bounded attenuation,
and offline loading. Upload tests preserve exact request bodies across retries.
Speaker tests cover swapped ASR labels, ambiguous matches, service failures,
different embedding models, overlaps, and incomplete annotations. Browser
workflows verify automatic preparation returns the original without DSP while
simulated BLE recording continues. Cloud request tests compare every uploaded
WAV byte after encrypted storage and on each ASR fallback.

Primary references: [RNNoise design and limitations](https://jmvalin.ca/demo/rnnoise/)
and [Gemini transcription and diarization](https://ai.google.dev/gemini-api/docs/transcribe).
Google documents attribution for three or more speakers as experimental.
