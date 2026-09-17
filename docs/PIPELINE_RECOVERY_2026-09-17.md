# Upload and transcription recovery — shell135

The phone logs show successful local capture, followed by Gemini HTTP 429 during transcription. The previous upload endpoint saved encrypted audio but waited for ASR before acknowledging success, which made quota errors look like failed uploads.

## Corrections

- The managed PWA uses `PUT .../segments/:index?transcription=deferred`. The server acknowledges encrypted storage without calling Gemini. Existing clients keep the inline behavior; older servers ignore the query and remain compatible.
- Finalization schedules the existing background worker. It processes missing windows one at a time and reuses completed transcripts. Upload jobs for other recordings continue during an AI cooldown. Partial cloud transcripts now arrive during background processing after the recording stops.
- Ordinary transcription uses a single text pass. Speaker/word-timestamp enrichment is explicit opt-in, and existing annotations are retained when complete. A successful unannotated window therefore submits half the audio of the previous two-pass path. The existing 1.5x prepared copy remains; original stored audio is unchanged. Empty/missing output recovery can still make additional requests, so this is not a fixed percentage reduction in the total bill.
- A transactional 120-second segment lease blocks concurrent model work across instances. The full ASR operation has a 90-second deadline; ambiguous transport failures keep the lease until expiry. Ownership is checked when saving results. Lease expiry permits crash recovery; it cannot guarantee provider-side exactly-once billing after a lost response.
- ASR HTTP transport errors return to durable job retry instead of immediately submitting the audio up to four times.
- `serviceModelCooldowns` stores only hashed model names, expiry, and quota category. A 429 suppresses calls across instances. `SYNAP_SHARED_MODEL_COOLDOWN` defaults to `1`; unit fixtures disable it and test the store separately. No new user data or credentials are stored there.
- Background failures retain safe error codes, provider status, quota category and retry timing. Cloud Tasks schedules a new delayed delivery before acknowledging a quota wait; if scheduling fails, the existing delivery remains retryable. The PWA retains those details without exhausting its ordinary retry counter.

## Recovery and verification

Reload to shell135, then retry the affected saved recording. Audio upload can complete while the provider is limited; transcription resumes after its cooldown. No re-recording or clearing browser storage is required.

Regression checks cover storage-only PUT and replay, immutable audio, one ordinary model submission, overlapping requests, lease expiry/fencing, shared cooldowns, delayed-task scheduling failure, and propagation of provider diagnostics to the PWA. Firestore CI tests simultaneous lease claims with the real SDK.

A deployment and passing fixtures do not establish that the production API project's quota is available. A signed-in recording reaching `ready` is the remaining live end-to-end check; a continuing 429 requires checking the project's actual quota/billing limits.

## Follow-up — shell136-retry

The 04:33 phone log reports a saved failure about 0.3 seconds after consolidation starts. That timing alone cannot establish a fresh provider rejection. Code review confirmed a recovery gap: replaying the finalization key returns its stored response without requeuing work, and the browser previously treated the saved failed status as a new 429. The browser could therefore increase its cooldown without restarting a worker.

- Failed, retryable processing now invokes the explicit retry endpoint once per polling run. The request key includes the failure revision, so a lost response can be replayed safely. Both local recordings and cloud-only monitors recover this way.
- Retrying during a persisted provider cooldown ensures a delayed Cloud Task exists and preserves the deadline. The browser treats that acknowledgement as queued work, without increasing rate-limit counters or blocking unrelated recordings.
- Expired failures transition atomically back to uploaded; a retry cannot reset a newer worker, a newer failure, or a deleted recording. Ambiguous task-dispatch errors leave recovery possible without overwriting active work.
- Rate limits encountered through authenticated process-now recovery now also schedule a durable task.
- Progress labels distinguish transcription, understanding, indexing, and waiting. A failed state no longer displays an understanding percentage.

Focused regression fixtures cover stored failure → retry → ready, cloud-only recovery, preserved cooldowns, task deduplication, and concurrent-worker protection. Production quota availability still requires a signed-in recording to complete; these changes do not alter provider quota or billing settings.
