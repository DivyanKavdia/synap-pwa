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
if (result.commit !== expected || !Array.isArray(result.checks) || !result.checks.length)
  process.exit(1);
if (status === '200' && result.ok === true && result.checks.every(check => check?.ok === true))
  process.exit(0);

// Exit 75 means "known transient provider cooldown". deploy.sh never promotes on
// this signal alone: it must observe the same class of cooldown on the currently
// serving revision, proving the failure is shared upstream rather than candidate-specific.
const failures = result.checks.filter(check => check?.ok !== true);
const cooldownCodes = new Set(['processing_deferred', 'model_rate_limited', 'model_daily_quota']);
const cooldown = status === '503' &&
  result.ok === false &&
  failures.length === 1 &&
  failures[0]?.name === 'audio_storage_and_transcription' &&
  cooldownCodes.has(failures[0]?.code) &&
  failures[0]?.httpStatus === 503 &&
  result.checks.some(check => check?.name === 'key_and_session' && check.ok === true) &&
  result.checks.some(check => check?.name === 'fixture_cleanup' && check.ok === true);
if (cooldown) process.exit(75);
process.exit(1);
NODE
