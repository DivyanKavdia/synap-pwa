# Synap end-to-end review — 17 September 2026

Reviewed PWA/backend `11670bd` and firmware `9f3003a`. The deployed backend
reported `11670bdd0d1209966fa3cfdbb98b69081485326c` at `/health`. Source and release
checks establish deployment identity, not successful private transcription.

## Findings and prepared fixes

| Priority | Finding | Change |
| --- | --- | --- |
| High | Deployment promoted a startup-healthy container without testing Gemini, queue dispatch, storage or indexes. | Require a real synthetic recording to pass authenticated upload, KMS unwrap, encrypted storage, transcription, Cloud Tasks, memory, indexed retrieval and Ask before promotion. Preserve the serving revision if it fails. |
| High | Terraform could add a placeholder Gemini secret version as `latest`; startup logged it but served healthy. | Remove version management without disabling existing versions; reject placeholder credentials at boot. |
| High | Terraform omitted the Cloud Tasks callback URL, and the missing-URL fallback ran detached work under idle CPU throttling. | Declare the URL, make CI own revision configuration, and reject incomplete production queue configuration at startup. |
| High | Task authentication accepted any Google identity if the expected invoker was absent. | Require a configured audience and the exact verified service identity. |
| Medium | Terraform declared collection-group indexes for queries against individual user subcollections, hid field drift, and omitted partial Actions filter indexes. | Declare collection indexes, add owner/state variants and a descending date index, stop hiding field changes, and prevent accidental replacement/deletion. |
| Medium | Date-scoped recent-conversation fallback ordered only by timestamp, disagreeing with the declared date index. | Order by descending day then timestamp; add an emulator regression check. |
| Medium | Existing indexes and other manual provisioning are not fully represented by the available Terraform state. | Add an existing-state-only plan command and a gate rejecting destructive changes, secret rotation, runtime/queue/IAM mutations. Document exact imports and ownership. |

## Layer review

**Firmware:** S3/C3/Chakshu share PCM16, 16 kHz audio, control, session recovery
and OTA contracts. Firmware and PWA device catalogs match byte for byte. Local
host tests passed (85, with four library-specific checks skipped locally). The
current [firmware release run](https://github.com/DivyanKavdia/synap-firmware/actions/runs/35128570820)
passed pinned-library tests, compilation for all three targets, publication,
manifest/binary verification and provenance. No firmware source change is needed
for the confirmed cloud configuration gaps.

**PWA:** Reviewed durable PCM/WAV storage, immutable upload retries, deferred
transcription, quota cooldown recovery, post-OTA queue recovery, account scoping,
record/stop/reconnect controls and media exclusions. Browser tests simulate
radios and native callbacks; they do not establish physical radio endurance.
Chakshu media remains local. No new background-iOS promise is introduced.

**Cloud:** Original audio remains separate from the 1.5x, pitch-preserving ASR
copy. Existing model retry/cooldown and transcript reuse protections remain.
The new readiness endpoint accepts only the deployment identity, takes no user
IDs/audio/URLs/models from its caller, creates a random synthetic account, and
cleans up only that account and audio. No user tokens, provider bodies or private
recordings are returned. Model fallbacks are checked separately so they cannot
hide an unavailable model during rollout.

**Infrastructure:** Secrets, KMS, storage, queue, Firestore and runtime identity
must be reconciled against the existing production state. The source change does
not itself import resources or apply infrastructure. Defaults for a new queue
are conservative; adoption must explicitly preserve the current queue limits.
The GitHub deployer receives no new project permissions. See
[the adoption procedure](TERRAFORM_ADOPTION.md).

## Validation and rollout boundaries

Backend build/type checking and 231 unit/route tests pass, including synthetic
readiness success/failure cleanup and exact-identity checks. Deployment failure
tests verify that failed candidate readiness prevents traffic promotion. The
Terraform plan gate has destructive-change/secret/runtime/queue tests. Terraform
formatting passes; provider validation runs in CI because the local execution
environment forbids the provider's Unix socket.

The PWA unit suite passed 476 checks in CI, including the additional live-readiness
rollback case. All six jobs in [the review workflow](https://github.com/DivyanKavdia/synap-pwa/actions/runs/35188893882)
passed, including the full browser suite, Terraform provider validation, WebKit
audio upload and Firestore emulator. The local combined browser run had one
12-second post-OTA C3 control timeout; the entire controls journey passed on its
focused rerun and in CI. That intermittent timeout remains a hardware/demo check
to watch.

A final deployment-only adjustment mints a fresh identity token before each
readiness request, avoiding expiration during a slow image build. It uses the
existing federated identity grant without changing IAM or the deployment
credential file. Its token-refresh tests and the pinned Google auth library's
ID-token request path are checked locally. All 478 PWA unit checks pass with
this adjustment; the live IAM call awaits deployment.

Before promotion, the candidate handles the synthetic session/upload while
Cloud Tasks still calls the existing canonical service. The same check runs
again after promotion, which verifies the new worker and triggers rollback on
failure. Each run uses only 6.885 seconds of synthetic speech and small model
requests. No business recording is read or retranscribed by the check.

The historical Gemini 429 report is not evidence that quota is available now.
The authenticated production readiness check has not yet run for this change.
Production publication was blocked by automatic approval review pending explicit
deployment approval; no production infrastructure apply was performed.

After approval: reconcile any missing collection indexes using the original
state and operator identity; merge/deploy through the gated workflow; require its
synthetic report to pass before promotion. If it reports Gemini access/quota
failure, resolve the API project's access/quota rather than adding Cloud Run
capacity. Then perform one physical 30-second pendant recording on each target
and confirm playback, transcript, summary, recovery and OTA on the phone.

Google references: [Gemini project-level quotas](https://ai.google.dev/gemini-api/docs/rate-limits),
[Firestore query/index ordering](https://firebase.google.com/docs/firestore/query-data/multiple-range-fields).
