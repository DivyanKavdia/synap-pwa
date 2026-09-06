/**
 * Synap backend infrastructure.
 *
 * The shape of this file follows one principle: the service account that runs
 * the API can use the customer-managed key, but cannot manage it, cannot read
 * the audit logs of its own use, and cannot grant itself anything further.
 * Compromising the running container therefore buys an attacker the ability to
 * decrypt data for as long as they hold it — not the ability to exfiltrate a
 * key and keep decrypting afterwards.
 */

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.12"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  services = [
    # Terraform's project IAM and service resources call through the Resource
    # Manager and Service Usage APIs. Omitting them fails the first apply on a
    # fresh project with an accessNotConfigured error that names an unrelated
    # resource, so they are enabled before anything that depends on them.
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "run.googleapis.com",
    "firestore.googleapis.com",
    "cloudkms.googleapis.com",
    "storage.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudtasks.googleapis.com",
    "generativelanguage.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "iamcredentials.googleapis.com",
    "billingbudgets.googleapis.com",
  ]
  audio_bucket = "${var.project_id}-synap-audio"
}

resource "google_project_service" "enabled" {
  for_each                   = toset(local.services)
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# ---------------------------------------------------------------------------
# Cloud KMS — the key that wraps every user's data encryption key
# ---------------------------------------------------------------------------

resource "google_kms_key_ring" "synap" {
  name       = "synap"
  location   = var.kms_location
  depends_on = [google_project_service.enabled]
}

resource "google_kms_crypto_key" "user_kek" {
  name     = "user-kek"
  key_ring = google_kms_key_ring.synap.id
  purpose  = "ENCRYPT_DECRYPT"

  # Rotation only ever rewraps 32-byte DEKs, so it is cheap and worth doing
  # often. Old versions stay enabled so previously wrapped DEKs keep opening.
  rotation_period = "${var.key_rotation_days * 24 * 60 * 60}s"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  # Destroying this key destroys every user's data irrecoverably. That is the
  # intended property, and exactly why Terraform must not do it by accident.
  lifecycle {
    prevent_destroy = true
  }
}

# The key used as the bucket's CMEK default. Separate from the DEK-wrapping key
# so storage-level and application-level encryption can be rotated and revoked
# independently.
resource "google_kms_crypto_key" "storage" {
  name            = "audio-storage"
  key_ring        = google_kms_key_ring.synap.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "${var.key_rotation_days * 24 * 60 * 60}s"

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Service accounts
# ---------------------------------------------------------------------------

resource "google_service_account" "api" {
  account_id   = "synap-api"
  display_name = "Synap backend (Cloud Run)"
}

resource "google_service_account" "tasks_invoker" {
  account_id   = "synap-tasks-invoker"
  display_name = "Cloud Tasks OIDC identity for the processing queue"
}

# The API may use the KEK. It may not administer it, schedule its destruction,
# or read who else used it.
resource "google_kms_crypto_key_iam_member" "api_uses_kek" {
  crypto_key_id = google_kms_crypto_key.user_kek.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_tasks" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# Needed so the API can mint the OIDC token Cloud Tasks presents back to it.
resource "google_service_account_iam_member" "api_impersonates_invoker" {
  service_account_id = google_service_account.tasks_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.api.email}"
}

# ---------------------------------------------------------------------------
# Firestore — structured memory
# ---------------------------------------------------------------------------

resource "google_firestore_database" "synap" {
  project                     = var.project_id
  name                        = "(default)"
  location_id                 = var.region
  type                        = "FIRESTORE_NATIVE"
  concurrency_mode            = "PESSIMISTIC"
  app_engine_integration_mode = "DISABLED"
  # Recovers from an accidental mass delete or a bad migration.
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"

  depends_on = [google_project_service.enabled]
}

# Vector index backing Ask Synap's nearest-neighbour retrieval. The dimension
# must match SYNAP_GEMINI_EMBED_DIMENSIONS exactly or findNearest fails at query
# time rather than at deploy time.
resource "google_firestore_index" "conversation_vectors" {
  project    = var.project_id
  database   = google_firestore_database.synap.name
  collection = "conversations"
  query_scope = "COLLECTION_GROUP"

  fields {
    field_path = "day"
    order      = "ASCENDING"
  }

  fields {
    field_path = "embedding"
    vector_config {
      dimension = 768
      flat {}
    }
  }

  lifecycle {
    ignore_changes = [fields]
  }
}

# The daily brief reads every recording for a day. where(day) + orderBy(startedAt)
# is a composite query, and its absence failed processing at the very last step —
# after transcription, understanding and indexing had all succeeded.
resource "google_firestore_index" "recordings_by_day" {
  project     = var.project_id
  database    = google_firestore_database.synap.name
  collection  = "recordings"
  query_scope = "COLLECTION_GROUP"

  fields {
    field_path = "day"
    order      = "ASCENDING"
  }

  fields {
    field_path = "startedAt"
    order      = "ASCENDING"
  }

  lifecycle {
    ignore_changes = [fields]
  }
}

# Retrieval's non-vector fallback: recent conversations within a date window.
resource "google_firestore_index" "conversations_by_day" {
  project     = var.project_id
  database    = google_firestore_database.synap.name
  collection  = "conversations"
  query_scope = "COLLECTION_GROUP"

  fields {
    field_path = "day"
    order      = "ASCENDING"
  }

  fields {
    field_path = "startedAt"
    order      = "DESCENDING"
  }

  lifecycle {
    ignore_changes = [fields]
  }
}

# Unprefixed vector index. A vector index's prefix fields must be EQUALITY
# filters; Ask Synap filters by date range and by array membership, neither of
# which qualifies. So nearest-neighbour search runs unfiltered against this
# index and the scope is applied to the results instead — see
# findNearestConversations.
resource "google_firestore_index" "conversation_vectors_plain" {
  project     = var.project_id
  database    = google_firestore_database.synap.name
  collection  = "conversations"
  query_scope = "COLLECTION_GROUP"

  fields {
    field_path = "embedding"
    vector_config {
      dimension = 768
      flat {}
    }
  }

  lifecycle {
    ignore_changes = [fields]
  }
}

resource "google_firestore_index" "conversations_by_person" {
  project     = var.project_id
  database    = google_firestore_database.synap.name
  collection  = "conversations"
  query_scope = "COLLECTION_GROUP"

  fields {
    field_path   = "personIds"
    array_config = "CONTAINS"
  }

  fields {
    field_path = "startedAt"
    order      = "DESCENDING"
  }

  lifecycle {
    ignore_changes = [fields]
  }
}

resource "google_firestore_index" "follow_ups" {
  project     = var.project_id
  database    = google_firestore_database.synap.name
  collection  = "followUps"
  query_scope = "COLLECTION_GROUP"

  fields {
    field_path = "state"
    order      = "ASCENDING"
  }

  fields {
    field_path = "ownerType"
    order      = "ASCENDING"
  }

  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }

  lifecycle {
    ignore_changes = [fields]
  }
}

# Reaps the idempotency ledger automatically instead of growing it forever.
resource "google_firestore_field" "idempotency_ttl" {
  project    = var.project_id
  database   = google_firestore_database.synap.name
  collection = "idempotency"
  field      = "expireAt"

  ttl_config {}
}

# Short-lived auth pairings. Application logic already refuses an expired
# pairing inside its transaction; this only stops the collection growing.
resource "google_firestore_field" "auth_pairings_ttl" {
  project    = var.project_id
  database   = google_firestore_database.synap.name
  collection = "authPairings"
  field      = "expireAt"

  ttl_config {}
}

# Rate-limit counters. Without a TTL the limiter would trade unbounded pairing
# documents for unbounded counter documents, which is not a fix.
resource "google_firestore_field" "rate_limits_ttl" {
  project    = var.project_id
  database   = google_firestore_database.synap.name
  collection = "rateLimits"
  field      = "expireAt"

  ttl_config {}
}

# ---------------------------------------------------------------------------
# Spend alerting
# ---------------------------------------------------------------------------

# Nothing else in this stack caps cost, and audio transcription is billed per
# minute of audio — ambient capture is mostly silence you are paying to
# transcribe. This does not stop spending; it makes runaway spending visible
# within a day instead of at the end of the month.
resource "google_billing_budget" "synap" {
  count = var.billing_account_id == "" ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "Synap monthly spend"

  budget_filter {
    projects = ["projects/${var.project_id}"]
  }

  amount {
    specified_amount {
      currency_code = "INR"
      units         = tostring(var.monthly_budget_inr)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  # Catches a runaway before month end, when the monthly percentages still look fine.
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
}

# ---------------------------------------------------------------------------
# Cloud Storage — sealed audio segments
# ---------------------------------------------------------------------------

data "google_storage_project_service_account" "gcs" {
  project    = var.project_id
  depends_on = [google_project_service.enabled]
}

resource "google_kms_crypto_key_iam_member" "gcs_uses_storage_key" {
  crypto_key_id = google_kms_crypto_key.storage.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

resource "google_storage_bucket" "audio" {
  name                        = local.audio_bucket
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  encryption {
    default_kms_key_name = google_kms_crypto_key.storage.id
  }

  # Raw audio is the most sensitive and least reusable artifact in the system.
  # Derived memory is what the product actually needs long term, so audio ages
  # out on a schedule while the memory stays.
  lifecycle_rule {
    condition {
      age = var.audio_retention_days
    }
    action {
      type = "Delete"
    }
  }

  versioning {
    enabled = false
  }

  depends_on = [google_kms_crypto_key_iam_member.gcs_uses_storage_key]
}

# The API reads and writes objects. It deliberately does not hold storage.admin,
# so it cannot alter the bucket's retention or encryption settings.
resource "google_storage_bucket_iam_member" "api_object_admin" {
  bucket = google_storage_bucket.audio.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "gemini_api_key" {
  secret_id = "synap-gemini-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret" "session_signing_key" {
  secret_id = "synap-session-signing-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

# Generated here so a human never has to invent one, and never sees it.
resource "random_bytes" "session_signing_key" {
  length = 32
}

resource "google_secret_manager_secret_version" "session_signing_key" {
  secret      = google_secret_manager_secret.session_signing_key.id
  secret_data = random_bytes.session_signing_key.base64
}

# Cloud Run fails its startup probe if this secret has no version: the service
# resolves secrets at boot and exits rather than serving with a missing key.
# A placeholder version lets a fresh project converge in one apply; the real key
# is added afterwards as a new version, which supersedes this one. Terraform
# ignores the data so adding the real key never shows up as drift.
resource "google_secret_manager_secret_version" "gemini_api_key_placeholder" {
  secret      = google_secret_manager_secret.gemini_api_key.id
  secret_data = "REPLACE_WITH_YOUR_GEMINI_API_KEY"

  lifecycle {
    ignore_changes = [secret_data, enabled]
  }
}

resource "google_secret_manager_secret_iam_member" "api_reads_gemini_key" {
  secret_id = google_secret_manager_secret.gemini_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_reads_session_key" {
  secret_id = google_secret_manager_secret.session_signing_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

# ---------------------------------------------------------------------------
# Cloud Tasks — the processing queue
# ---------------------------------------------------------------------------

resource "google_cloud_tasks_queue" "processing" {
  name     = "synap-processing"
  location = var.region

  rate_limits {
    # Gemini quota, not Cloud Run capacity, is the real ceiling here.
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 10
  }

  retry_config {
    max_attempts       = 5
    min_backoff        = "10s"
    max_backoff        = "600s"
    max_doublings      = 4
    max_retry_duration = "3600s"
  }

  depends_on = [google_project_service.enabled]
}

# ---------------------------------------------------------------------------
# Cloud Run — the API
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "backend" {
  name                = "synap-backend"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.api.email
    timeout         = "1800s"

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = 20
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        # Transcription is IO-bound on Gemini; without this the instance is
        # throttled between requests and a queued batch crawls.
        cpu_idle = false
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "SYNAP_LOCATION"
        value = var.region
      }
      env {
        name  = "SYNAP_GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }
      env {
        name  = "SYNAP_ALLOWED_ORIGINS"
        value = join(",", var.allowed_origins)
      }
      env {
        name  = "SYNAP_AUDIO_BUCKET"
        value = google_storage_bucket.audio.name
      }
      env {
        name  = "SYNAP_AUDIO_RETENTION_DAYS"
        value = tostring(var.audio_retention_days)
      }
      env {
        name  = "SYNAP_KMS_LOCATION"
        value = var.kms_location
      }
      env {
        name  = "SYNAP_KMS_KEY_RING"
        value = google_kms_key_ring.synap.name
      }
      env {
        name  = "SYNAP_KMS_KEY_ID"
        value = google_kms_crypto_key.user_kek.name
      }
      env {
        name  = "SYNAP_TASKS_QUEUE"
        value = google_cloud_tasks_queue.processing.name
      }
      env {
        name  = "SYNAP_TASKS_LOCATION"
        value = var.region
      }
      env {
        name  = "SYNAP_TASKS_INVOKER_SA"
        value = google_service_account.tasks_invoker.email
      }
      env {
        name  = "SYNAP_GEMINI_API_KEY_SECRET"
        value = google_secret_manager_secret.gemini_api_key.secret_id
      }
      env {
        name  = "SYNAP_SESSION_SIGNING_KEY_SECRET"
        value = google_secret_manager_secret.session_signing_key.secret_id
      }

      ports {
        container_port = 8080
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.api_reads_gemini_key,
    google_secret_manager_secret_iam_member.api_reads_session_key,
  ]
}

# The API is public because a browser calls it; every endpoint that touches data
# still requires a Synap session token.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.backend.name
  location = google_cloud_run_v2_service.backend.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Cloud Tasks presents an OIDC token for this identity when calling the worker.
resource "google_cloud_run_v2_service_iam_member" "tasks_invoker" {
  name     = google_cloud_run_v2_service.backend.name
  location = google_cloud_run_v2_service.backend.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.tasks_invoker.email}"
}
