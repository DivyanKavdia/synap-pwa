# Synap Voice Profile

Voice Profile lets Synap distinguish the enrolled account owner from other diarized speakers and render that speaker as **You** in the final transcript.

## Product behaviour

1. Open **Settings → Memory & AI → Voice profile**.
2. Choose **Set up** and explicitly consent to creating a voice profile.
3. Speak naturally for about 10 seconds using the phone microphone.
4. The browser converts the sample to mono 16 kHz PCM WAV and sends it to the authenticated Synap backend.
5. The backend forwards that WAV to the private `synap-speaker` service only long enough to compute an ECAPA-TDNN speaker embedding.
6. The raw enrollment sample is discarded. Only the embedding, model id and sample duration are stored, encrypted with the user's existing Synap DEK.
7. During final meeting understanding, diarized speaker regions are compared with the enrolled profile. Only a conservative high-confidence match is changed from `S1`/`S2` to `YOU`.
8. The PWA renders `YOU` as **You**.

**Re-record** replaces the encrypted profile. **Delete** removes it. Deleting a profile stops future self-speaker identification; it does not rewrite historical memories.

## Reliability boundary

Speaker verification is optional metadata enrichment, not part of the recording or STT success path. Rolling 30-second transcription remains unchanged. If the profile is absent, the speaker service is unavailable, raw audio has aged out, the sample is too short, or the confidence threshold/margin is not met, Synap keeps the original diarization labels and continues processing normally.

## Privacy boundary

- Enrollment is explicit and account-scoped.
- Enrollment audio is not added to Library or IndexedDB.
- The speaker service has no Firestore, GCS, KMS or Secret Manager permissions.
- The speaker Cloud Run service is private; only the `synap-api` service account receives `roles/run.invoker`.
- Stored embeddings are envelope-encrypted using the same per-user DEK used for Synap memory.
- No persistent raw voice sample is required for identification.

A speaker embedding should be treated as sensitive biometric-like data even though it cannot reproduce the original recording. Access, deletion and retention should therefore remain stricter than ordinary UI preferences.

## First deployment

The existing backend infrastructure remains valid when Voice Profile is disabled. To enable it, build the speaker image and let Terraform create the private service:

```bash
export PROJECT_ID=<YOUR_GCP_PROJECT_ID>
export REGION=asia-south1
./infra/deploy-speaker.sh
```

The Terraform directory must have the same normal Synap variables available as an existing infrastructure apply (`project_id`, backend `image`, `google_client_id`, and any environment-specific overrides), typically through `terraform.tfvars` or `TF_VAR_*` variables.

After the speaker service is created, deploy the backend:

```bash
export PROJECT_ID=<YOUR_GCP_PROJECT_ID>
export REGION=asia-south1
./infra/deploy.sh
```

`infra/deploy.sh` discovers `synap-speaker` and updates the backend with:

- `SYNAP_SPEAKER_SERVICE_URL=<private Cloud Run URL>`
- `SYNAP_SPEAKER_SERVICE_AUTH=oidc`

If `synap-speaker` is absent, the backend starts normally and Voice Profile reports `available: false`.

## Verification

After backend deployment:

1. Sign in to Synap Cloud.
2. Open Settings and confirm **Voice profile** is available.
3. Enroll with at least 5 seconds of clean speech; the default UI captures about 10 seconds.
4. Record a short two-person conversation where the wearer speaks for at least ~3 seconds in one 30-second processing window.
5. Wait for the memory to reach `ready`.
6. Open **Transcript** and verify the wearer is shown as **You** while the other speaker remains a diarization label unless separately identified.
7. Delete the Voice Profile and confirm a new meeting falls back to S1/S2-style labels.

Do not lower the default matching threshold or margin merely to increase the number of `You` labels. Calibrate those values against real pendant recordings first; false self-attribution is worse than leaving a speaker unidentified.
