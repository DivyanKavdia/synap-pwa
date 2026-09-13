# Synap demo readiness — 13 September 2026

The software has a clearer first-use journey and stronger recovery boundaries.
**A live pendant demo still requires a fresh C3 and S3 hardware acceptance run.**
The supplied recordings contained long silent regions; no automated browser test
can establish that the physical radio and microphone path now behaves correctly.
Do not describe this release as bug-free or hardware-certified.

## What changed

| Area | Result |
| --- | --- |
| First use | A direct pendant/online-meeting recording path, sign-in guidance and a first-save “Create memory” action replace the empty starting point. |
| Product explanation | A clearly labeled sample demonstrates summary → next step → original words. It never writes to personal recordings or actions. It remains available in Settings → Support. |
| Processing ownership | A transaction claims each attempt. Stale attempts cannot publish, mark a newer attempt failed, or resurrect a deleted recording. |
| Retry correctness | Sealed understanding is reused; conversations, people contributions, follow-ups and the ready checkpoint commit together. Existing completed/dismissed tasks survive retries. |
| Daily summary | Failure to refresh a day leaves the recording ready. A task retry rebuilds the day without rerunning transcription/understanding. |
| Meeting capture | Ownership begins before permission prompts. Stop keeps the journal until saving succeeds; failed saves can be retried. Media permissions are released promptly; the main header shows the meeting timer, stop/save control and save-retry state. |
| Account changes | Local sign-out ends immediately. A delayed revoke or profile response cannot clear/restore a different sign-in session. |

The C3/S3 gesture release remains firmware build **1192**: double-tap to start or
stop; hold four seconds and release to sleep or wake. This readiness pass changes
the PWA/backend; it does not supply new evidence about physical touch sensitivity.

## Evidence and limits

- `npm test`: 275 app checks, including permission/start races, save retry,
  account changes, recording transport, audio storage and recovery contracts.
- `npm test --prefix backend`: 169 backend checks, including atomic rollback,
  concurrent task-completion replay, worker fencing, deleted recordings, legacy
  duplicate tasks and daily-summary recovery.
- The production validation workflow runs the full browser suite, including the
  new first-memory journey at 320, 390, 768 and 1440 pixels in both themes. It
  checks keyboard navigation, source links, first-save processing and that the
  sample creates no personal records. Screenshots are retained with each run.
- A separate CI job runs the real Firestore SDK against a disposable emulator:
  overlapping claims, concurrent recordings/person counts, completion retention
  and stale/deleted publication. It uses no production credentials.
- CI results and deployed commit IDs belong to the release PR/workflow run.
  A source test, browser fixture or emulator pass is not a production load test.
  The [Firestore emulator documentation](https://docs.cloud.google.com/firestore/native/docs/emulator)
  describes differences in concurrency, indexes and transaction limits.

## Hardware acceptance before the investor meeting

Use the actual demo phone/browser, charged pendant and intended microphone case.
Record the app revision, firmware build, board, phone, OS and browser version.

| Run on both C3 and S3 | Required observation |
| --- | --- |
| Ten double-tap start/stop cycles | Exactly one recording per cycle; start/stop feedback agrees with the app; each take saves. |
| Hold four seconds, release, wake again | One sleep/wake transition; no accidental recording; the app returns to a usable connection. |
| Thirty-minute continuous conversation | No unplanned reconnects or unexplained silence while someone is speaking. Inspect the beginning, middle, end and known spoken checkpoints. |
| Phone in the expected pocket/position | The same connection and intelligibility result as the intended demonstration setup. |
| Brief, intentional Bluetooth interruption | The UI reports the interruption, recovers or offers saving of received audio, and identifies actual gaps. It must not imply missing speech was recovered. |
| Network interruption during processing | Audio remains available locally; reconnect/retry finishes one memory and one set of actions. |
| Summary and source review | Names, numbers, negations, decisions and owners match the actual words; each source opens the right point. Unstated dates/owners remain absent. |

Keep exported WAVs and copied diagnostic logs with the run. If spontaneous
disconnects or silent speech recur, stop using live capture for the pitch until
the paired phone/pendant logs explain the failure. The previous uploaded audio
does not establish a cause or identify the firmware build used to record it.

## A five-minute demonstration

1. **Explain the outcome:** stay present in a conversation, then retrieve a
   decision and the action it created. Use the built-in sample if explaining the
   UI; call it a sample.
2. **Record one short real conversation:** agree on one decision and one owner,
   speak a distinctive number, and leave one question unresolved. Use the
   acceptance-tested pendant and phone. Stop and save.
3. **Create the memory:** sign in beforehand. Enable automatic memory creation
   only if desired; otherwise use “Create memory”/Library → Process recording.
4. **Prove the result:** open the summary, follow a source back to the original
   words/audio, then complete an action. Show the unresolved question rather
   than claiming the model can infer its answer.
5. **Show continuity:** revisit the saved recording and the day's memory. Keep
   one previously recorded, personally reviewed conversation available as a
   transparent fallback if connectivity is unavailable.

## Remaining engineering work

Historical people overcounts from older partial indexing writes cannot be
reconstructed reliably from the available metadata. New publication prevents
retry inflation; it is not a migration that invents corrected historical counts.

The original app controller and several CSS/presentation layers remain large.
Continue extracting explicit boundaries with behavior tests, rather than adding
startup wrappers. Production monitoring should track processing failures and
latency separately from device disconnect/gap diagnostics. A representative
multi-user load test and real Gemini/phone acceptance are still needed before
claiming launch-scale reliability.
