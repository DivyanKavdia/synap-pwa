# Transcription quality and recovery

Standalone audio from S3, C3 and Chakshu follows the same source-preserving pipeline. Improving a transcript cannot recover samples that never reached storage. The header distinguishes elapsed time from audio received; transport gaps and microphone quality remain separate from model failures.

## Recognition before speaker labels

The first transcription pass uses verbatim text without word timestamps. It keeps the original language, including mixed-language speech. An optional speaker/timestamp pass has a bounded deadline and can contribute annotations only when its complete text agrees with the first pass. Missing or partial annotations never replace recognized words. Managed ASR uses a disposable, pitch-preserving 1.5× copy for both passes; the source WAV remains unchanged in the browser and encrypted storage. See [audio cost controls](TRANSCRIPTION_COST.md).

Explicitly incomplete provider responses and missing text output get one recovery pass with original 1× audio and default recognition settings. A failed recovery remains a retryable error and cannot be sealed as silence. An explicitly empty result gets one fresh pass with automatic language detection using the original 1× audio. If both results are empty, the recording completes as **No recognizable speech**, with its original audio still available; it does not enter an endless summarisation retry. Digitally zero windows retain their source and skip the model. Windows under five seconds remain at normal speed.

Cloud errors distinguish missing output, incomplete output, request rejection, rate limits and model access failures. The browser retains the public error code and numeric provider HTTP status, and labels model failures as transcription of saved audio rather than failed upload. Provider bodies, audio, transcript content and keys are never included in these diagnostics. The subsequent September 17 shell131 log identifies Gemini HTTP 429 on the final window. This confirms a provider rate or usage limit; the log alone does not identify which project quota was reached.

HTTP 429 stops backend transport retries immediately. Structured `RetryInfo` and `Retry-After` delays are honored with a minimum 60-second cooldown; an explicitly identified daily quota starts at one hour. Other requests for the same model are suppressed within that backend runtime until the deadline. The browser persists a provider/account cooldown with the job, waits across reloads and selected Retry clicks, and increases repeated rate-limit delays from one minute to fifteen minutes (or a longer provider delay). A 429 leaves jobs pending without consuming the five-attempt failure budget; completed segments remain complete. This suppression does not increase project quota or provide a distributed quota reservation across backend instances. [Gemini quota documentation](https://ai.google.dev/gemini-api/docs/rate-limits) explains the project-level limits.

Each successful upload response includes the window transcript, which is saved in IndexedDB before the job completes. The PWA displays joined window text while final processing continues. Retrying an already uploaded window preserves this text and the exact original upload bytes.

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

Tests cover original WAV integrity, real FFmpeg pitch and tail preservation, accelerated timestamp mapping, normal-speed empty-result recovery, retry submission counts, mixed-language text preservation, disagreeing annotations, incomplete output, empty-result recovery and atomic publication. Browser tests cover rolling local soundtracks across a 30-second boundary, reload, export, no cloud jobs and blocked stale jobs, plus partial transcript persistence before summaries. Fixture tests do not measure speech accuracy on the user's microphones or prove radio endurance; representative physical recordings remain the acceptance check.
