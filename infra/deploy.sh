#!/usr/bin/env bash
#
# Build, push and deploy the Synap backend.
#
# Terraform provisions new installations. This script deploys the image and
# backend CPU policy to an existing, healthy production service. Do not apply
# Terraform to the existing production project; see docs/GITHUB_DEPLOY.md.
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
check=(node "${here}/infra/check-cloud-run.cjs")
run_scope=(--region="${REGION}" --project="${PROJECT_ID}")
transcription_speed="${SYNAP_TRANSCRIPTION_SPEED:-1.5}"
case "$transcription_speed" in 1|1.5) ;; *) echo "SYNAP_TRANSCRIPTION_SPEED must be 1 or 1.5" >&2; exit 1;; esac

# Configuration snapshots can contain private environment values. Keep them
# local with restrictive permissions; only revision names go into the CI log.
umask 077
work="$(mktemp -d)"
promotion_attempted=false
candidate_attempted=false
rollout_tag="deploy-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
candidate_revision="${SERVICE}-${rollout_tag}"

describe_service() {
  gcloud run services describe "${SERVICE}" "${run_scope[@]}" --format=json > "$1"
}

check_health() {
  local endpoint="$1" expected="$2"
  # Retry both transport errors and propagation of traffic/commit metadata.
  for attempt in 1 2 3 4 5 6; do
    if curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
      "${endpoint}/health" > "${work}/health.json" && \
      "${check[@]}" health "${work}/health.json" "${expected}"; then
      return 0
    fi
    [[ "$attempt" == 6 ]] || sleep 3
  done
  return 1
}

finish() {
  local result=$?
  trap - EXIT
  if [[ "$result" != 0 && "$promotion_attempted" == true ]]; then
    echo "==> Deployment verification failed; restoring ${previous_revision}" >&2
    if describe_service "${work}/rollback.json" && \
      "${check[@]}" rollback-allowed "${work}/rollback.json" "${previous_revision}" "${candidate_revision}" && \
      "${rollback[@]}" && describe_service "${work}/rollback.json" && \
      "${check[@]}" serving "${work}/rollback.json" "${previous_revision}" && \
      check_health "${url}" "${previous_sha}"; then
      echo "Rollback verified: ${previous_revision} is serving 100% of traffic." >&2
    else
      echo "ROLLBACK NOT VERIFIED. Use the exact rollback command printed above and inspect Cloud Run." >&2
    fi
  fi
  if [[ "$candidate_attempted" == true ]]; then
    gcloud run services update-traffic "${SERVICE}" "${run_scope[@]}" \
      --remove-tags="${rollout_tag}" --quiet >/dev/null || \
      echo "Could not remove temporary tag ${rollout_tag}; remove it after inspecting the service." >&2
  fi
  rm -rf "${work}"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "==> Verifying the build before it can reach production"
command -v ffmpeg >/dev/null || { echo "Install FFmpeg before running the ASR validation and deployment." >&2; exit 1; }
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

echo "==> Capturing the serving revision and checking production configuration"
describe_service "${work}/before.json"
baseline="$("${check[@]}" baseline "${work}/before.json")"
IFS=$'\t' read -r previous_revision url <<< "${baseline}"
gcloud run revisions describe "${previous_revision}" "${run_scope[@]}" \
  --format=json > "${work}/previous.json"
previous_sha="$("${check[@]}" origin "${work}/before.json" "${work}/previous.json")"
check_health "${url}" "${previous_sha}"
rollback=(gcloud run services update-traffic "${SERVICE}" "${run_scope[@]}" \
  --to-revisions="${previous_revision}=100" --quiet)
echo "Previous revision: ${previous_revision}"
echo "Exact rollback command:"
printf '%q ' "${rollback[@]}"; printf '\n'
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '### Backend rollout'
    echo "Previous revision: \`${previous_revision}\`"
    echo "Candidate revision: \`${candidate_revision}\`"
    echo 'Rollback:'
    echo '```bash'
    printf '%q ' "${rollback[@]}"; printf '\n'
    echo '```'
  } >> "${GITHUB_STEP_SUMMARY}"
fi

env_vars="SYNAP_SERVICE_URL=${url}"
env_vars="${env_vars},SYNAP_OPERATIONS_INVOKER_SA=synap-github-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

# Pin model routing on every deploy. Summary/memory quality is user-visible, so
# full Flash is the baseline for extraction and query interpretation. Flash-Lite
# is intentionally not used on these quality-critical paths.
stt_model="${SYNAP_GEMINI_STT_MODEL:-gemini-3.5-transcribe}"
memory_model="${SYNAP_GEMINI_MEMORY_MODEL:-gemini-3.8-flash}"
query_model="${SYNAP_GEMINI_QUERY_MODEL:-gemini-3.5-flash}"
ask_model="${SYNAP_GEMINI_ASK_MODEL:-gemini-3.8-flash}"
env_vars="${env_vars},SYNAP_GEMINI_STT_MODEL=${stt_model},SYNAP_TRANSCRIPTION_SPEED=${transcription_speed},SYNAP_GEMINI_MEMORY_MODEL=${memory_model},SYNAP_GEMINI_QUERY_MODEL=${query_model},SYNAP_GEMINI_ASK_MODEL=${ask_model}"

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

echo "==> Staging ${candidate_revision} with one CPU and idle throttling"
describe_service "${work}/current.json"
"${check[@]}" unchanged "${work}/before.json" "${work}/current.json"
candidate_attempted=true
# One revision contains the image, build identity, URLs and CPU settings.
# update-env-vars preserves all existing secret references and other settings.
gcloud run deploy "${SERVICE}" "${run_scope[@]}" \
  --image="${IMAGE}" --cpu=1 --cpu-throttling \
  --update-env-vars="${env_vars}" \
  --revision-suffix="${rollout_tag}" --tag="${rollout_tag}" --no-traffic --quiet

gcloud run revisions describe "${candidate_revision}" "${run_scope[@]}" \
  --format=json > "${work}/candidate.json"
"${check[@]}" candidate "${work}/previous.json" "${work}/candidate.json" "${env_vars}" "${candidate_revision}"
describe_service "${work}/staged.json"
candidate_url="$("${check[@]}" staged "${work}/staged.json" "${previous_revision}" "${candidate_revision}" "${rollout_tag}")"
check_health "${candidate_url}" "${build_sha}"

echo "==> Verifying a synthetic recording through production dependencies"
bash "${here}/infra/check-readiness.sh" "${candidate_url}" "${url}" "${build_sha}"

# Recheck after the probe so an observed concurrent rollout cannot be promoted.
describe_service "${work}/staged.json"
"${check[@]}" staged "${work}/staged.json" "${previous_revision}" "${candidate_revision}" "${rollout_tag}" >/dev/null
echo "==> Promoting the verified candidate"
promotion_attempted=true
gcloud run services update-traffic "${SERVICE}" "${run_scope[@]}" \
  --to-revisions="${candidate_revision}=100" --quiet
describe_service "${work}/live.json"
"${check[@]}" serving "${work}/live.json" "${candidate_revision}"
check_health "${url}" "${build_sha}"
bash "${here}/infra/check-readiness.sh" "${url}" "${url}" "${build_sha}"
promotion_attempted=false

echo
echo "Deployed: ${url}"
echo "Models: STT=${stt_model}, memory=${memory_model}, query=${query_model}, ask=${ask_model}"
if [[ -n "${speaker_url}" ]]; then
  echo "Voice profile service: configured (private Cloud Run service)"
fi
echo "Set the backend URL in the PWA (Settings, or SYNAP_BACKEND_URL in synap-backend.js)."
