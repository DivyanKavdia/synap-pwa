# Automatic speech preparation and speaker continuity

New Synap Cloud processing windows are prepared locally before upload. The
bundled RNNoise model runs in a dedicated Worker; there is no prompt or extra
download from a model provider. The original capture journal stays on the device.
Cloud transcription receives the prepared copy.

The previous preview used the fully denoised signal, which can suppress distant
voices and consonants. The replacement mixes a bounded correction into the
time-aligned original. At 16 kHz every sample keeps its sign and at least 70% of
its original amplitude (apart from integer rounding). There is no silence gate,
speech-probability gate, gain boost, or removal of pauses. The preview/export
control uses the same guarded algorithm.

This is deliberately mild suppression, capped at approximately 3.1 dB of sample
attenuation. The generated noise fixture measured about 3 dB reduction and zero
sample offset. Those measurements demonstrate the guard and timing; they do not
establish lower word-error or diarization-error rates on real pendant audio.
Clipping, packet loss, and voices talking over one another remain limitations.

Automatic work is bounded to the normal 30-second windows (up to 60 seconds of
16 kHz PCM for legacy inputs) with a 12-second processing budget. Unsupported,
busy or failing Workers fall back to original audio. Upload cancellation stops
the Worker. The selected upload bytes are stored before sending and reused on
retry/reload, including original-audio fallbacks. Successful uploads discard the
temporary copy and retain an acknowledgement marker, avoiding duplicate uploads.
Existing cloud audio is not automatically retranscribed.

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

Transcript completeness is checked per window. A partial annotation response
keeps that window's full text without stripping speaker labels from every other
window. The complete source transcript remains authoritative.

## Verification

Tests exercise the actual bundled model with generated audio, including quiet
speech-like signals, short tails, silence, cancellation, bounded attenuation,
and offline loading. Upload tests preserve exact request bodies across retries.
Speaker tests cover swapped ASR labels, ambiguous matches, service failures,
different embedding models, overlaps, and incomplete annotations. Browser
workflows run local preprocessing while simulated BLE recording continues and
check the revised rectangular Ask source cards at mobile and desktop widths.

Primary references: [RNNoise design and limitations](https://jmvalin.ca/demo/rnnoise/)
and [Gemini transcription and diarization](https://ai.google.dev/gemini-api/docs/transcribe).
Google documents attribution for three or more speakers as experimental.
