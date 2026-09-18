# Transcription quality and recovery

Standalone audio from S3, C3 and Chakshu follows the same source-preserving
pipeline. Better ASR cannot recover samples that never reached storage, so Synap
keeps capture/reconnect integrity separate from model recovery.

## Long-form recognition

Local capture and cloud source storage remain 30-second durable windows. Final
processing no longer sends those windows to Gemini one by one. The backend groups
contiguous missing windows into provider batches, 20 minutes by default, decrypts
and concatenates PCM only in memory, prepares the disposable 1.5× copy and sends
that batch through the Gemini Files API.

Long batches use Gemini 3.5 Transcribe verbatim mode with primary word timestamps.
The returned words are mapped back to the original 30-second source timeline and
sealed per source window, so the rest of Synap does not need a storage migration.
If the user has explicitly enrolled a wearer voice or known speakers, diarization
is enabled in that **same** primary request. Without that opt-in, only timestamps
are requested. This avoids a second transcription request solely for annotations.

The batch result is accepted only when timestamped words reproduce the complete
recognized text after the existing evidence-preserving normalization. Incomplete
timestamps, incomplete provider responses and missing output leave the original
audio untouched and schedule durable recovery. They do not trigger an immediate
second submission of the same audio. Digitally zero batches skip the model;
source windows with no words inside an otherwise valid batch are stored as
no-speech windows.

Legacy/single-window ASR retains the existing text-first compatibility path and
the long-cooldown `gemini-3.8-flash` continuity fallback. That flat-text fallback
is intentionally **not** used for a long batch, because a batch without timestamps
cannot be safely projected back onto its source windows.

## Rate limits and recovery

Gemini 429s are treated as project/model conditions, not individual-window errors.
Both Files API and Interactions API 429 responses preserve provider retry guidance
and write the same shared cooldown. All Cloud Run instances check that deadline
before a new long-file upload or model request.

Short throttles wait. Explicit daily quota guidance gets a long cooldown. Missing
or incomplete output uses a separate 120-second recording retry delay. Completed
source windows remain completed, failed batches retain all encrypted audio, and
explicit retry cannot bypass an active provider deadline.

The default 20-minute batch turns a fully untranscribed 60-minute recording from
roughly 120 primary ASR calls into about three, while leaving capture durability
unchanged. See [audio cost controls](TRANSCRIPTION_COST.md).

## Grounded summaries

Final processing requires all expected windows. The memory prompt asks for coverage across the conversation, including final corrections, while keeping unsupported speaker identities, action owners and deadlines unknown. Transcript content is evidence, not instructions to the model. Decisions and follow-ups must pass the same conversation-level evidence and timestamp checks as other extracted facts. A no-speech result publishes no invented people, actions or decisions.

## Processing during firmware updates

A firmware installation pauses the processing queue and waits for an interrupted upload to return to its saved pending job. When the update finishes, fails or is cancelled, a previously running queue resumes with the same selected recordings and existing provider cooldown. A queue that was already paused, or explicitly paused again during the update, stays paused. Intentional cancellation is reported as paused processing, retains the original audio and does not consume a retry.

## Retry older recordings

A processing deadline is reported as a retryable timeout, including when the
browser delivers its expired timer after returning to the foreground. An
explicit queue pause leaves work pending without consuming a retry. Neither
condition changes the saved audio or an already accepted upload body.

In **Library**, filter **Needs retry**, select the affected standalone recordings, and choose **Process selected**. Previously empty transcripts without the current review marker are re-transcribed from their preserved cloud source. A compare-and-set write prevents a late retry from replacing a newer completed result. Existing nonempty transcripts remain idempotent.

If the original WAV sounds unclear, first compare received duration and transport diagnostics. A storage-read error retains the source for recovery after reopening the app; a malformed source requires explicit repair rather than more model attempts. These changes do not silently rewrite old transcripts or guess missing speech.

## Local media boundary

Photos, video frames and newly paired soundtracks stay on the current browser. They show **On this device**, do not appear under missing transcript/summary filters, and do not contribute pending AI costs. Manual retries and custom providers cannot upload them. Standalone audio recordings remain eligible for cloud transcription. Earlier independently recorded audio linked to a photo retains its existing processing policy.

## Validation

Tests cover original WAV integrity, real FFmpeg pitch and tail preservation, accelerated timestamp mapping, cloud-batch numbering and legacy 30-second compatibility, normal-speed empty-result recovery, retry submission counts, mixed-language text preservation, disagreeing annotations, incomplete output, empty-result recovery and atomic publication. Browser tests cover rolling local soundtracks across a 30-second boundary, reload, export, no cloud jobs and blocked stale jobs, plus partial transcript persistence before summaries. Fixture tests do not measure speech accuracy on the user's microphones or prove radio endurance; representative physical recordings remain the acceptance check.
