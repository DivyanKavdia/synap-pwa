#!/usr/bin/env bash
# Read/plan only. Run from the operator's existing initialized production state.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="${SYNAP_TERRAFORM_DIR:-${root}/infra/terraform}"
plan_file="${SYNAP_TERRAFORM_PLAN:?Set an absolute private path for the reviewed binary plan}"
[[ "$plan_file" == /* ]] || { echo 'SYNAP_TERRAFORM_PLAN must be absolute' >&2; exit 1; }
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
terraform -chdir="$state_dir" state list > "${work}/resources"
for resource in google_cloud_run_v2_service.backend google_firestore_database.synap google_storage_bucket.audio; do
  if ! grep -Fxq "$resource" "${work}/resources"; then
    echo "Existing production state is missing ${resource}. Restore/import state first; do not apply a fresh state to production." >&2
    exit 1
  fi
done
terraform -chdir="$state_dir" plan -input=false -out="$plan_file" "$@"
terraform -chdir="$state_dir" show -json "$plan_file" > "${work}/plan.json"
node "${root}/infra/check-terraform-plan.cjs" "${work}/plan.json"
echo 'Plan saved. Review it before applying that exact binary plan; no cloud changes were made.'
