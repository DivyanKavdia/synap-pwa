#!/usr/bin/env bash
#
# Build the private speaker-verification image and let Terraform own the service.
#
# The existing Terraform variables (project_id, image, google_client_id, etc.)
# should already be available through terraform.tfvars or TF_VAR_* just as they
# are for the normal Synap infrastructure. Extra terraform arguments may be
# supplied after this script.
#
#   PROJECT_ID=my-project ./infra/deploy-speaker.sh
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-asia-south1}"
REPO="${REPO:-synap}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/speaker:${TAG}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Ensuring the Artifact Registry repository exists"
gcloud artifacts repositories describe "${REPO}" \
  --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker --location="${REGION}" --project="${PROJECT_ID}" \
  --description="Synap service images"

echo "==> Building speaker image ${IMAGE}"
gcloud builds submit "${here}/speaker-service" --tag "${IMAGE}" --project="${PROJECT_ID}"

echo "==> Applying private speaker service through Terraform"
(
  cd "${here}/infra/terraform"
  terraform init
  terraform apply \
    -var="speaker_enabled=true" \
    -var="speaker_image=${IMAGE}" \
    "$@"
)

echo "==> Verifying private speaker service exists"
speaker_url="$(gcloud run services describe synap-speaker \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --format='value(status.url)')"
[[ -n "${speaker_url}" ]] || { echo "Speaker service has no URL" >&2; exit 1; }

echo "Speaker service deployed privately: ${speaker_url}"
echo
echo "Next: redeploy the backend so it picks up the speaker URL:"
echo "  PROJECT_ID=${PROJECT_ID} REGION=${REGION} ./infra/deploy.sh"
