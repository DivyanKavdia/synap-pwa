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

# Cloud Build uploads source to a staging bucket. Granted narrowly to that
# bucket rather than project-wide storage access.
gcloud storage buckets add-iam-policy-binding "gs://${PROJECT_ID}_cloudbuild" \
  --member="serviceAccount:${DEPLOY_SA}" --role="roles/storage.objectAdmin" 2>/dev/null \
  || echo "Staging bucket not created yet; re-run this line after the first build."
```

That last grant is the step most setups forget, and it fails partway through the
first run with a message about object permissions rather than anything obviously
IAM-shaped.

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

That last step matters more than it sounds. Cloud Run serves the same service on
two hostnames and numbers revisions independently of git, so a green deploy step
only proves `gcloud` exited zero. The workflow reads `/health`, compares the
reported commit against `GITHUB_SHA`, and fails if traffic is still on an older
revision.

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
| Cloud Build fails uploading source | The staging bucket grant in step 3. Re-run that line. |
| `iam.serviceAccounts.actAs` denied | The `synap-api` binding in step 3 was skipped. |
| Deploy succeeds, verification fails | Traffic is on an older revision. The failure step prints the rollback command. |
| Workflow does not run at all | The `paths:` filter — PWA-only changes deliberately do not deploy. |

## What this does not cover

Terraform stays manual and reviewed. It is deliberately absent from `paths:`.

That is not caution for its own sake: `terraform apply` on this project is
currently unsafe. It wants to add a placeholder version to the Gemini API key
secret, which would become `latest` and break transcription; it wants to strip
`SYNAP_SERVICE_URL` from Cloud Run, which would stop Cloud Tasks; and it fails on
three Firestore indexes created by hand and never imported. Use `-target` until
that is repaired, and never let CI near it.
