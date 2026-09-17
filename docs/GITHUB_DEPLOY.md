# Deploying the backend from GitHub

Push backend code to `main` and Cloud Run updates itself. GitHub authenticates
with a short-lived OIDC token exchanged through Workload Identity Federation —
there is no service-account key to store, leak or rotate.

Run this once. About fifteen minutes.

## What gets created

| Thing | Purpose |
| --- | --- |
| `synap-github-deployer` service account | Deploy-only identity for CI |
| Workload identity pool `github` | Trust anchor for GitHub tokens |
| Provider `synap-github` | Restricts trust to this repo and branch |

The runtime identity `synap-api` is untouched. CI can deploy the service; it
cannot read anyone's recordings. Keep it that way.

Everything below is additive — a new account and new grants. Nothing existing is
modified or replaced, so a failed attempt cannot break what is running.

## 1. Create the identity and the trust

```bash
export PROJECT_ID=gen-lang-client-0697897308
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export DEPLOY_SA="synap-github-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"

gcloud iam service-accounts create synap-github-deployer \
  --project="$PROJECT_ID" --display-name="Synap GitHub backend deployer"

gcloud iam workload-identity-pools create github \
  --project="$PROJECT_ID" --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc synap-github \
  --project="$PROJECT_ID" --location=global --workload-identity-pool=github \
  --display-name="Synap GitHub Actions" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='DivyanKavdia/synap-pwa' && assertion.ref=='refs/heads/main'"
```

The attribute condition is the security boundary: only this repository, only
`main`. A fork, a pull request from a fork, or a push to any other branch cannot
obtain credentials.

## 2. Let the repo impersonate the deployer

```bash
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --project="$PROJECT_ID" --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/DivyanKavdia/synap-pwa"
```

## 3. Grant deploy permissions

```bash
for ROLE in roles/run.admin \
            roles/cloudbuild.builds.editor \
            roles/artifactregistry.writer \
            roles/serviceusage.serviceUsageConsumer
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" --role="$ROLE" --condition=None >/dev/null
done

# Deploying a service that runs as synap-api requires permission to act as it.
gcloud iam service-accounts add-iam-policy-binding \
  "synap-api@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="$PROJECT_ID" --member="serviceAccount:${DEPLOY_SA}" \
  --role="roles/iam.serviceAccountUser"

# CI stages build source in its own bucket, created on first deploy, rather
# than the shared PROJECT_cloudbuild one. Project-wide storage access would be
# the usual fix and would also give CI read access to the sealed audio bucket;
# a dedicated bucket holding only build tarballs is the smaller permission.
gcloud storage buckets create "gs://${PROJECT_ID}-synap-ci-source" \
  --project="$PROJECT_ID" --location=asia-south1 --uniform-bucket-level-access \
  2>/dev/null || echo "(bucket already exists — fine)"

gcloud storage buckets add-iam-policy-binding "gs://${PROJECT_ID}-synap-ci-source" \
  --member="serviceAccount:${DEPLOY_SA}" --role="roles/storage.admin"
```

The shared `PROJECT_cloudbuild` bucket is deliberately avoided. Granting a
deploy identity enough access to use it tends to end at project-wide storage
permissions, and this project's storage includes the sealed audio bucket. The
error you get otherwise actively misleads:

```
ERROR: (gcloud.builds.submit) The user is forbidden from accessing the bucket
[PROJECT_cloudbuild]. ... or if the user has the "serviceusage.services.use"
permission.
```

It names `serviceusage.services.use`, which is already granted a few lines
above, and `roles/storage.admin` on that bucket does not resolve it either.
Using a bucket the deploy identity owns outright sidesteps the question.

## 4. Identifiers

The workflow carries them inline, so nothing needs to be configured in GitHub:

| Value | Where |
| --- | --- |
| WIF provider | `.github/workflows/deploy-backend.yml`, `workload_identity_provider` |
| Deploy service account | same file, `service_account` |
| Project and region | same file, the `env:` blocks |

They are inline rather than repository variables because managing those needs
repo-admin access, which a collaborator does not have. Nothing is lost: none of
these are secrets. A project id, a region, a service-account email and a pool
name are all public-safe, and Google's own documentation prints them verbatim.

The security boundary is the provider's attribute-condition in GCP, which admits
only `DivyanKavdia/synap-pwa` on `refs/heads/main`. Someone holding all four
strings and no access to that repository can obtain nothing.

Never add a `GCP_SERVICE_ACCOUNT_KEY` or any JSON credential. That is the thing
this setup exists to avoid, and unlike the strings above it *is* a secret.

## 5. Run it

**Actions → Deploy Synap Backend → Run workflow.** It will test, build, deploy,
then verify that the commit now serving traffic is the one it just built.

`infra/deploy.sh` first captures the revision receiving 100% of traffic and its
configuration. It creates one tagged revision with **no production traffic**,
checks the configuration and tagged `/health` commit, then runs a synthetic
recording through authenticated upload, KMS, encrypted storage, transcription,
Cloud Tasks, memory, vector retrieval and Ask Synap before promoting that revision. It checks the traffic assignment and public `/health` commit
again, including another synthetic check through the newly serving worker. A
failed promotion or live verification attempts to restore the captured
revision and verifies rollback. The workflow keeps deployments serialized; do
not run a manual deploy or change traffic while one is running.

The exact rollback command is printed **before** deployment and saved in the job
summary. This also covers an interrupted runner where automatic cleanup cannot
finish. Never select a rollback revision by guessing from the most recent list:
the latest created revision is not necessarily the one that was serving users.

## Backend CPU cost rollout

The September 16 cost commit updated only Terraform. The deployment script now
sets `--cpu=1 --cpu-throttling` explicitly, so the existing image deployment path
can apply that policy without running Terraform. Memory stays at its existing
value (the repository config is `2Gi`), as do concurrency, timeout, scaling and
runtime identity. The optional speaker service is only discovered; its CPU
policy is not changed.

The candidate check compares against the **serving revision**, including after
a rollback. It rejects unexpected environment changes or secret-reference
changes and requires the configured Cloud Tasks URL, queue, location and caller
identity. Model routing, build identity and service URLs are the only intentional
environment updates, using `--update-env-vars`. No secret versions, indexes, IAM
policies or queue resources are updated by the cost change.

This preflight assumes one healthy backend revision serving 100% of traffic,
with `SYNAP_SERVICE_URL` equal to the service's canonical URL. A split rollout,
unfinished deployment or incompatible configuration stops deployment for review.
It does not silently normalize an unfamiliar production setup.

### First rollout checks

1. Before merging or dispatching, record current processing latency, Cloud Run
   CPU/memory utilization, error rate and Cloud Tasks backlog/retry behavior.
   Confirm there is no concurrent manual infrastructure work.
2. Merge the reviewed deployment patch, or run the workflow on that commit once
   it is on `main`. Preserve the job summary's previous revision and rollback
   command. The deploy job runs backend tests and deployment failure-path tests.
3. Confirm the workflow verifies one CPU, throttling enabled, preserved runtime
   configuration, and the expected commit at the candidate and public URLs.
4. Using an existing signed-in test account, upload and finalize a short test
   recording. Confirm a **Cloud Tasks dispatch** completes, the transcript and
   memory appear, and Ask Synap retrieves that recording. Repeat after idle and
   with representative concurrent recordings. This exercises Gemini, queue OIDC,
   Firestore indexes and the current FFmpeg preprocessing path.
5. Compare processing latency, queue progress, errors and CPU/memory under
   comparable load. Roll back for new secret/auth/index errors, stuck or growing
   retries, audio-preparation timeouts, memory failures or sustained processing
   latency regression. Inspect subsequent billed usage before claiming savings.

`/health` proves startup and build identity. Promotion also requires the private
`POST /ops/readiness` check, authenticated by the exact configured deployer Google
identity and canonical service audience. That check only creates synthetic data
in a random disposable account; it never returns a user session or accepts user
IDs, audio, URLs or model names from the caller. Its report contains only stage
results and sanitized errors. The fixture is removed afterward. Startup rejects
a placeholder Gemini key or incomplete Cloud Tasks configuration on Cloud Run. Later September 16 commits also added FFmpeg CPU work, so
the original cost commit's entirely-I/O-bound rationale needs production
measurement. No performance guarantee follows from the CPU setting alone.

CI mints a fresh Google identity token immediately before each readiness request
from the action's refreshable federated credentials. This avoids carrying a
short-lived token across a potentially slow build. It uses the existing
`workloadIdentityUser` grant on the deployment service account; it requires no
new IAM binding, private key, or self-impersonation permission. The credential
file used by `gcloud` for deployment and rollback is left intact.

### Rollback

Run the **exact command in the deployment job summary** to send 100% of traffic
back to the captured revision. Then check Cloud Run's traffic assignment, the
previous commit at `/health`, and a queued test recording. Traffic changes take
time to propagate and do not instantly end requests already in flight.

Before promotion, a failed candidate keeps production traffic on the old
revision. After promotion is attempted, the script tries rollback even if the
traffic-update command itself fails, since the API may already have applied it.
If a different deployment or operator has visibly taken over, automatic rollback
stops for manual inspection rather than overwriting that traffic change.
Any failed rollback check leaves the job failed and prints an explicit warning.
Temporary candidate tags are removed on exit; if the runner is killed, remove
the named tag manually after verifying traffic. Configuration snapshots are local
temporary files and are never uploaded as CI artifacts.

Rollback restores the old revision's image and CPU settings for serving traffic;
it does not change the newer service template. Pause further deployments while
investigating: every run of the patched script deliberately requests one CPU and
throttling again. Keep Terraform excluded from deployment triggers.

Google references: [CPU throttling flags](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update),
[billing and CPU allocation](https://docs.cloud.google.com/run/docs/configuring/billing-settings),
and [revision tags, traffic and rollback](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration).

## Checking what is live, any time

```bash
curl -s https://synap-backend-435475937223.asia-south1.run.app/health
```

```json
{"status":"ok","version":1,"service":"synap-backend","commit":"1f075d2","built_at":"2026-09-07T14:31:02Z"}
```

Compare `commit` with `git rev-parse --short HEAD`. A hand-run `deploy.sh` stamps
the short SHA; CI stamps the full one. `"unknown"` means the deploy did not pass
the values — the service is fine, but it cannot tell you what it is.

## When something breaks

| Symptom | Cause |
| --- | --- |
| `Permission denied on resource ... workloadIdentityPools` | The attribute condition rejected the token. Check repository and branch match exactly. |
| `forbidden from accessing the bucket ..._cloudbuild` | deploy.sh should be staging into `PROJECT-synap-ci-source`. If this appears, an older deploy.sh is running — pull main. |
| `iam.serviceAccounts.actAs` denied | The `synap-api` binding in step 3 was skipped. |
| Deploy succeeds, verification fails | Traffic is on an older revision. The failure step prints the rollback command. |
| Workflow does not run at all | The `paths:` filter — PWA-only changes deliberately do not deploy. |

## What this does not cover

Terraform stays manual and reviewed. It is deliberately absent from `paths:`.

Terraform now preserves secret versions and treats Cloud Run revisions as owned
by `infra/deploy.sh`. It declares the per-user collection indexes used by the
backend and refuses accidental index/data deletion. Existing production state
must still be reconciled; this source change does not import manually created
indexes or apply infrastructure automatically. See
[production Terraform adoption](TERRAFORM_ADOPTION.md).

Google documents [project-level Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).
Adding Cloud Run CPU or creating another API key cannot increase those limits.
If the live synthetic check reports a quota/access error, keep the old revision
serving and resolve the API project's billing/quota configuration before retrying.
