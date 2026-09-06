# ---------------------------------------------------------------------------
# Optional private speaker-verification service
# ---------------------------------------------------------------------------
#
# This service deliberately has its own service account with no Firestore, GCS,
# KMS or Secret Manager grants. It receives a short WAV, returns an embedding,
# and has no authority to read or persist Synap user data. The public PWA cannot
# invoke it: only the synap-api Cloud Run identity receives roles/run.invoker.

resource "google_service_account" "speaker" {
  count        = var.speaker_enabled ? 1 : 0
  account_id   = "synap-speaker"
  display_name = "Synap speaker verification (no data access)"
}

resource "google_cloud_run_v2_service" "speaker" {
  count               = var.speaker_enabled ? 1 : 0
  name                = "synap-speaker"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.speaker[0].email
    timeout         = "60s"

    scaling {
      min_instance_count = var.speaker_min_instances
      max_instance_count = 5
    }

    containers {
      image = var.speaker_image

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle = false
      }

      env {
        name  = "SYNAP_SPEAKER_MODEL"
        value = "speechbrain/spkrec-ecapa-voxceleb"
      }
      env {
        name  = "SYNAP_SPEAKER_SERVICE_MIN_MS"
        value = "2000"
      }
      env {
        name  = "SYNAP_SPEAKER_SERVICE_MAX_MS"
        value = "30000"
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
        failure_threshold     = 24
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_cloud_run_v2_service_iam_member" "api_invokes_speaker" {
  count    = var.speaker_enabled ? 1 : 0
  name     = google_cloud_run_v2_service.speaker[0].name
  location = google_cloud_run_v2_service.speaker[0].location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.api.email}"
}
