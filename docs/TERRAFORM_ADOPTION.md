# Adopting existing production infrastructure

The code fixes the known drift hazards. It does **not** supply the production
state or apply it. Keep infrastructure changes separate from image rollouts.

## Ownership

| Resource | Owner |
| --- | --- |
| Secret metadata and IAM bindings | Terraform |
| Secret payload versions | Explicit Secret Manager provisioning/rotation |
| Cloud Run service identity and invoker grants | Terraform |
| Cloud Run revisions, environment, CPU, traffic | `infra/deploy.sh` |
| Firestore indexes, queue, storage, KMS | Terraform with existing state |

Terraform 1.7+ `removed` blocks detach legacy generated/placeholder secret
versions with `destroy = false`. They neither disable nor destroy versions.
Old state backups may contain the signing key; keep them private. Do not rotate
the session key as part of adoption. The runtime now rejects a placeholder key.

Cloud Run ignores revision/template and traffic drift because CI owns those
fields. This preserves the Gemini model routes, speaker URL, secret references,
Cloud Tasks audience, one-CPU policy and rollback state across Terraform applies.

## Existing production procedure

1. Use the original initialized state/backend, its lock, workspace and production
   variable file. Do not create a fresh state against existing infrastructure.
   Back up state privately using `terraform state pull`. Never upload state,
   binary plans or raw service environment snapshots as CI artifacts.
2. Record the serving revision and its canonical `status.url`, the live queue
   rate/concurrency, optional speaker service settings, and existing indexes.
   Set `service_url` to that exact URL. Set `processing_dispatches_per_second`,
   `processing_concurrency`, `speaker_enabled` and `speaker_image` to their live
   values during adoption. Defaults are intended for a new small installation.
3. List indexes without reading documents:

   ```sh
   gcloud firestore indexes composite list --project=gen-lang-client-0697897308 --database='(default)' --format=json
   ```

   Match the full field definition and **COLLECTION** query scope used by each
   per-user subcollection query. Import matching existing indexes by their full
   resource name. Do not delete/recreate a serving index to resolve ALREADY_EXISTS.

   | Terraform address suffix | Collection | Fields |
   | --- | --- | --- |
   | `conversation_vectors` | conversations | day ASC, embedding VECTOR(768) |
   | `recordings_by_day` | recordings | day ASC, startedAt ASC |
   | `conversations_by_day` | conversations | day ASC, startedAt DESC |
   | `conversations_by_day_recent` | conversations | day DESC, startedAt DESC |
   | `conversation_vectors_plain` | conversations | embedding VECTOR(768) |
   | `conversations_by_person` | conversations | personIds CONTAINS, startedAt DESC |
   | `follow_ups` | followUps | state ASC, ownerType ASC, createdAt DESC |
   | `follow_ups_by_state` | followUps | state ASC, createdAt DESC |
   | `follow_ups_by_owner` | followUps | ownerType ASC, createdAt DESC |

   Prefix each address with `google_firestore_index.`. Example, substituting the
   exact ID returned by the listing:

   ```sh
   terraform import -var-file=production.tfvars google_firestore_index.recordings_by_day 'projects/gen-lang-client-0697897308/databases/(default)/collectionGroups/recordings/indexes/EXACT_EXISTING_ID'
   ```

   If a state address already points to a different index/scope, stop and review
   that binding. `prevent_destroy` deliberately blocks replacement. No command
   in this change removes an index or discards the production state.
4. Generate a saved, constrained plan from the repo root:

   ```sh
   SYNAP_TERRAFORM_PLAN=/secure/synap-adoption.tfplan bash infra/plan-production.sh -var-file=production.tfvars
   ```

   The gate permits imports/no-ops, detaching the three legacy secret state
   entries without destruction, and creating missing collection indexes. It
   rejects deletion, replacement, new secret versions, runtime changes, IAM
   changes and queue changes. A rejection requires review of the actual drift.
5. Review and apply that exact saved plan with the existing infrastructure
   operator identity. Do not expand the GitHub deployer's permissions. Wait for
   new indexes to be READY, then run the authenticated synthetic readiness check
   through the backend deployment workflow. Record the report and rollback revision.

Gemini quota belongs to the API project. A successful infrastructure plan cannot
prove model availability, and new API keys do not create independent project
quota. Inspect the specific provider failure if the live synthetic check fails.

## Additive index repair when the original state is unavailable

The **Provision missing Synap indexes** workflow uses the existing deploy
identity to list indexes and create only missing definitions from
`infra/terraform/main.tf`. It waits for all declared indexes to become READY.
The script has no delete, replacement, IAM, secret or runtime operations, and
does not initialize or modify Terraform state. A permission failure stops it;
it never expands the deployer's role. An operator with existing index access can
run `PROJECT_ID=gen-lang-client-0697897308 node infra/provision-indexes.cjs --apply`.
Omit `--apply` to report readiness only.

The workflow prints exact resource-to-address mappings. Reconcile these with
the original workspace using the import procedure above before any subsequent
Terraform apply. An existing state binding to a different scope still requires
operator review; additive index creation does not resolve that state conflict.

References: [non-destructive state removal](https://developer.hashicorp.com/terraform/language/block/removed),
[Firestore indexes](https://firebase.google.com/docs/firestore/query-data/indexing),
[Gemini quota](https://ai.google.dev/gemini-api/docs/rate-limits).
