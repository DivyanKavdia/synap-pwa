#!/usr/bin/env bash
# Short-lived Google identity only; never read a user token or secret payload.
set -euo pipefail
endpoint="${1:?candidate URL}"
audience="${2:?service audience}"
expected="${3:?expected commit}"
umask 077
check_work="$(mktemp -d)"
trap 'rm -rf "$check_work"' EXIT
if [[ -n "${SYNAP_DEPLOY_ID_TOKEN:-}" ]]; then
  printf '%s' "$SYNAP_DEPLOY_ID_TOKEN" > "${check_work}/token"
elif [[ -n "${GOOGLE_GHA_CREDS_PATH:-}" ]]; then
  # Mint just before each check; a token made before a slow build can expire.
  node "$(dirname "${BASH_SOURCE[0]}")/readiness-identity.cjs" "$audience" > "${check_work}/token"
else
  gcloud auth print-identity-token --audiences="$audience" > "${check_work}/token"
fi
# Keep the token out of argv, process listings and shell tracing.
{ printf 'Authorization: Bearer '; tr -d '\n' < "${check_work}/token"; printf '\n'; } > "${check_work}/headers"
status="$(curl --silent --show-error --connect-timeout 10 --max-time 300 \
  --request POST --header @"${check_work}/headers" \
  --output "${check_work}/result.json" --write-out '%{http_code}' "${endpoint}/ops/readiness")"
node - "${check_work}/result.json" "$expected" "$status" <<'NODE'
const fs = require('node:fs');
const [file, expected, status] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(file, 'utf8'));
// The endpoint deliberately returns only build identity and sanitized checks.
console.log(JSON.stringify(result));
if (status !== '200' || result.ok !== true || result.commit !== expected || !result.checks?.length)
  process.exit(1);
NODE
