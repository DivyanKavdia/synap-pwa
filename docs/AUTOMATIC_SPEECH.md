# Source audio and speaker continuity

New Synap Cloud uploads use the original saved PCM WAV. The app does not run
RNNoise, filters, gain, normalization or silence removal before upload. The
backend passes the entire stored upload to ASR, including very quiet samples
and pauses, with the original recording offset. Only an entirely zero PCM window
can skip ASR; its exact cloud source is retained and its transcript is empty.

Noise reduction remains an explicit preview/export action. It creates a
separate copy and does not replace the capture, cloud source or transcript.

Before a request is sent, its exact body is saved for retries. A pending request
created by an older app may already contain processed audio accepted by the
server. That cached body is retained to avoid a conflicting digest on retry.
New request bodies are marked `source-pcm-v1` in local segment metadata; old
cached bodies are not relabeled. `stored-upload-v1` on a newly transcribed cloud
segment means ASR used the stored upload without Synap trimming or amplitude gating
(or the exact-zero shortcut returned an empty transcript).
Existing cloud recordings/transcripts are not automatically overwritten.

The upload compatibility entry point `prepareForUpload` now returns the original
Blob without starting a Worker, including during a partial app update. The
provider also bypasses enhancement directly, protecting both update orders.
WAV validation still rejects malformed sample alignment before upload/storage.

See the [audio pipeline guide](AUDIO_PIPELINE.md) for transport, memory,
compatibility, evidence and hardware acceptance limits.

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
workflows verify uncompressed PCM from notifications through IndexedDB, WAV,
upload selection and playback, and exercise explicit preview enhancement.

Primary references: [RNNoise design and limitations](https://jmvalin.ca/demo/rnnoise/)
and [Gemini transcription and diarization](https://ai.google.dev/gemini-api/docs/transcribe).
Google documents attribution for three or more speakers as experimental.
