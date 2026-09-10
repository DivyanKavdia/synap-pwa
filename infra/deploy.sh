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

STAGING_BUCKET="${STAGING_BUCKET:-${PROJECT_ID}-synap-ci-source}"
if ! gcloud storage buckets describe "gs://${STAGING_BUCKET}" \
     --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> Creating source staging bucket gs://${STAGING_BUCKET}"
  gcloud storage buckets create "gs://${STAGING_BUCKET}" \
    --project="${PROJECT_ID}" --location="${REGION}" \
    --uniform-bucket-level-access
fi

echo "==> Building ${IMAGE}"
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

env_vars="SYNAP_SERVICE_URL=${url}"

# Pin model routing on every deploy. Summary/memory quality is user-visible, so
# full Flash is the baseline for extraction and query interpretation. Flash-Lite
# is intentionally not used on these quality-critical paths.
stt_model="${SYNAP_GEMINI_STT_MODEL:-gemini-3.5-transcribe}"
memory_model="${SYNAP_GEMINI_MEMORY_MODEL:-gemini-3.5-flash}"
query_model="${SYNAP_GEMINI_QUERY_MODEL:-gemini-3.5-flash}"
ask_model="${SYNAP_GEMINI_ASK_MODEL:-gemini-3.8-flash}"
env_vars="${env_vars},SYNAP_GEMINI_STT_MODEL=${stt_model},SYNAP_GEMINI_MEMORY_MODEL=${memory_model},SYNAP_GEMINI_QUERY_MODEL=${query_model},SYNAP_GEMINI_ASK_MODEL=${ask_model}"

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
