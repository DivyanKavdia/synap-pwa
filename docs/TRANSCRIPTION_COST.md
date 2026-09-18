# Transcription input and cost controls

Synap deliberately separates **storage/recovery granularity** from **Gemini request
granularity**.

The browser continues to seal and upload the existing 30-second PCM16 WAV windows.
Those small immutable objects are the recovery boundary: reconnect, upload retry,
deletion and source integrity remain unchanged. After a recording is finalized,
the backend reads only the contiguous windows that still need ASR, decrypts them
in memory and groups them into long provider batches. The default is 20 minutes
(`SYNAP_TRANSCRIPTION_BATCH_MINUTES=20`), with a hard code cap of 25 minutes so
timestamped requests remain below Gemini 3.5 Transcribe's 30-minute annotated-audio
limit.

Before provider submission, the backend makes a disposable pitch-preserving 1.5×
copy with FFmpeg. A full 20-minute source batch therefore becomes about 10 minutes
of submitted audio. The encrypted GCS source objects are never replaced and no
plaintext temporary file is written to disk.

Long batches are uploaded through the Gemini Files API and the returned URI is
passed to the Interactions API. Synap deletes the temporary Gemini file best-effort
as soon as inference finishes; provider expiry is the cleanup backstop. A known
shared model cooldown is checked before the Files API upload so Synap does not
upload a large temporary file that cannot yet be transcribed.

## Request-count control

The old design could make one Gemini transcription request for every 30-second
storage window: up to 120 ASR requests for one hour of audio. With the default
20-minute provider batch, the same hour needs about three primary ASR requests
when every window is missing a transcript. The source still consists of the same
120 independently recoverable 30-second windows.

Provider batching is sequential within a recording. Each batch claims every
source-window transcription lease before any paid model request. The ordinary
single-window lease remains 120 seconds; a long-form batch gets a six-minute
lease around a five-minute batch budget. Its Interactions request has a four-minute
transport timeout. This prevents a slow valid batch from being claimed again by
a recovery worker while also bounding genuinely stuck work.

HTTP 429 handling is shared across Files API preparation and Interactions API
inference. `Retry-After` / structured retry guidance is persisted as a project/model
cooldown so another worker cannot immediately upload or submit the same batch.
Missing or incomplete model output is a separate retry class: it returns to the
durable recording queue with a 120-second delay rather than immediately submitting
the same audio again.

## Quality and timestamps

A long batch requests word timestamps in its **primary** Gemini 3.5 Transcribe
call. Those timestamps exist for one reason: to project the batch result
deterministically back onto the original 30-second source windows. The complete
recognized text must agree with the returned word annotations before Synap accepts
the batch.

If the account has opted into wearer/known-speaker identity, the same primary
request also asks for speaker diarization. It does not spend a second Gemini
transcription call for speaker labels. Accounts without speaker identity request
timestamps only. Existing downstream speaker enrichment and consent boundaries
remain in place.

Word timestamps can reduce ASR accuracy, so the batch size is intentionally well
inside the provider's annotated-audio limit and transcript/annotation agreement
is validated before publication. Legacy/single-window transcription keeps its
text-first behavior. A deterministic HTTP 400 request-shape rejection can retry
once with a compatible configuration; rate limits, access failures, missing output
and incomplete output never trigger an immediate duplicate audio submission.

Short windows under five seconds stay at normal speed. `SYNAP_TRANSCRIPTION_SPEED=1`
disables the 1.5× optimization without changing saved source audio or completed
transcripts.

## What savings mean

1.5× reduces submitted audio duration by approximately one third. Long-form
batching separately reduces the **number of transcription requests** by up to
about 30× versus one request per 30-second window. Neither number is a statement
about the final bill: output tokens, retries, memory extraction, embeddings,
speaker-service work and infrastructure have their own costs.

A completed long batch records its provider submission usage once rather than
duplicating the same batch usage onto every 30-second source window. Numeric-only
logs retain model/stage and provider usage counters; they never include audio,
transcript text or recording IDs. A timed-out provider request may still have
been billed even if no response reached Synap.

The UI's rupee estimate remains a historical illustration, not an account billing
ledger. Do not present it as a current invoice until model-specific input/output
rates, provider counters and failed-job usage are reconciled.

## Reference repository assessment

Reviewed [ScalabeMeetingTranscribe at fb33a87](https://github.com/myExperimentsWithTruth/ScalabeMeetingTranscribe/tree/fb33a875b4b025c6ef49e76f46c14fb7d72c3411).
It is an MIT-licensed Python meeting pipeline, not a cost-governance framework.
Its applicable ideas are FFmpeg tempo adjustment, source-time correction,
chronological chunk assembly, cached completed chunks and bounded retry/backoff.
Synap uses those general ideas independently while retaining its own encrypted
30-second recovery source, long-form provider batching, leases and durable queue.

## Verification and practical limit

Automated checks cover real FFmpeg duration/pitch/tail preservation, original
source integrity, 20-minute batch grouping, Gemini Files API URI transport,
timestamp projection, one-call diarization, missing/incomplete-output backoff,
429 cooldown propagation and lease fencing. Firestore integration tests exercise
publication/recovery transactions. These checks prove pipeline behavior, not
measured recognition accuracy; representative Hindi, English and Hinglish audio
should still be compared for names, numbers, corrections, noisy rooms and final
utterances before claiming an accuracy improvement.
