#!/usr/bin/env bash
#
# Build, push and deploy the Synap backend.
#
# Terraform owns the infrastructure; this script owns the image. Run Terraform
# first (see docs/GCP_DEPLOYMENT.md), then use this for every subsequent deploy.
# If the optional synap-speaker service exists, its private URL is pinned into
# the backend automatically so Terraform/service creation and image deployment
# remain separate concerns.
#
#   PROJECT_ID=my-project ./infra/deploy.sh
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-asia-south1}"
REPO="${REPO:-synap}"
SERVICE="${SERVICE:-synap-backend}"
SPEAKER_SERVICE="${SPEAKER_SERVICE:-synap-speaker}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/backend:${TAG}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Verifying the build before it can reach production"
( cd "${here}/backend" && npm ci && npm test )

echo "==> Ensuring the Artifact Registry repository exists"
gcloud artifacts repositories describe "${REPO}" \
  --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker --location="${REGION}" --project="${PROJECT_ID}" \
  --description="Synap backend images"

# Source staging bucket.
#
# Left to itself, gcloud builds submit stages into PROJECT_cloudbuild, a shared
# bucket whose default permissions a narrowly-scoped deploy identity does not
# satisfy. Granting project-wide storage access would fix it and would also hand
# CI read access to the sealed audio bucket, which defeats the point of keeping
# the deploy identity separate from the runtime one.
#
# A dedicated bucket holding nothing but build tarballs is both simpler to
# reason about and the smaller permission.
STAGING_BUCKET="${STAGING_BUCKET:-${PROJECT_ID}-synap-ci-source}"
if ! gcloud storage buckets describe "gs://${STAGING_BUCKET}" \
     --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> Creating source staging bucket gs://${STAGING_BUCKET}"
  gcloud storage buckets create "gs://${STAGING_BUCKET}" \
    --project="${PROJECT_ID}" --location="${REGION}" \
    --uniform-bucket-level-access
fi

echo "==> Building ${IMAGE}"
# Build logs go to our own bucket too. Streaming from Cloud Build's default log
# bucket requires project Viewer, which for this project means read access to
# Firestore — every user's memories — just to watch a build scroll past. A
# bucket the deploy identity already owns costs nothing and keeps the logs.
gcloud builds submit "${here}/backend" --tag "${IMAGE}" --project="${PROJECT_ID}" \
  --gcs-source-staging-dir="gs://${STAGING_BUCKET}/source" \
  --gcs-log-dir="gs://${STAGING_BUCKET}/logs"

echo "==> Deploying ${SERVICE}"
gcloud run deploy "${SERVICE}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --quiet

url="$(gcloud run services describe "${SERVICE}" --region="${REGION}" \
  --project="${PROJECT_ID}" --format='value(status.url)')"

# The service needs to know its own URL to enqueue Cloud Tasks that call back
# into it, and that URL only exists after the first deploy.
env_vars="SYNAP_SERVICE_URL=${url}"

# Model routing is pinned on every deploy rather than relying only on application
# fallbacks. This prevents an old manually-set Cloud Run variable from silently
# sending high-volume extraction back to an expensive general-purpose model.
stt_model="${SYNAP_GEMINI_STT_MODEL:-gemini-3.5-transcribe}"
memory_model="${SYNAP_GEMINI_MEMORY_MODEL:-gemini-3.5-flash-lite}"
query_model="${SYNAP_GEMINI_QUERY_MODEL:-gemini-3.5-flash-lite}"
ask_model="${SYNAP_GEMINI_ASK_MODEL:-gemini-3.8-flash}"
env_vars="${env_vars},SYNAP_GEMINI_STT_MODEL=${stt_model},SYNAP_GEMINI_MEMORY_MODEL=${memory_model},SYNAP_GEMINI_QUERY_MODEL=${query_model},SYNAP_GEMINI_ASK_MODEL=${ask_model}"

# Stamp the running build so /health can prove which commit is live. TAG is the
# short SHA when deploying from a git checkout; GITHUB_SHA wins in CI, where the
# full SHA is what a workflow run can be matched against.
build_sha="${GITHUB_SHA:-${TAG}}"
build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
env_vars="${env_vars},SYNAP_BUILD_SHA=${build_sha},SYNAP_BUILD_TIME=${build_time}"

speaker_url="$(gcloud run services describe "${SPEAKER_SERVICE}" \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --format='value(status.url)' 2>/dev/null || true)"
if [[ -n "${speaker_url}" ]]; then
  echo "==> Found private speaker service: ${speaker_url}"
  env_vars="${env_vars},SYNAP_SPEAKER_SERVICE_URL=${speaker_url},SYNAP_SPEAKER_SERVICE_AUTH=oidc"
else
  echo "==> Speaker service not present; voice profiling remains disabled"
fi

echo "==> Pinning runtime service URLs and model routing"
gcloud run services update "${SERVICE}" \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --update-env-vars="${env_vars}" --quiet

echo "==> Health check"
curl -fsS "${url}/health" && echo

echo
echo "Deployed: ${url}"
echo "Models: STT=${stt_model}, memory=${memory_model}, query=${query_model}, ask=${ask_model}"
if [[ -n "${speaker_url}" ]]; then
  echo "Voice profile service: configured (private Cloud Run service)"
fi
echo "Set the backend URL in the PWA (Settings, or SYNAP_BACKEND_URL in synap-backend.js)."
