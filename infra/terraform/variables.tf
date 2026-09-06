variable "project_id" {
  description = "GCP project that will hold Synap user data."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Firestore, GCS and Cloud Tasks. Keep user data close to the users; asia-south1 is Mumbai."
  type        = string
  default     = "asia-south1"
}

variable "kms_location" {
  description = "Cloud KMS location. Must be a region KMS supports; it does not have to match var.region but keeping them together avoids cross-region latency on every unwrap."
  type        = string
  default     = "asia-south1"
}

variable "google_client_id" {
  description = "OAuth 2.0 Web client ID the PWA signs in with."
  type        = string
}

variable "allowed_origins" {
  description = "Origins permitted to call the API and read the audio bucket."
  type        = list(string)
  default     = ["https://divyankavdia.github.io"]
}

variable "audio_retention_days" {
  description = "Days after which raw audio objects are deleted. Derived memory outlives them."
  type        = number
  default     = 30
}

variable "key_rotation_days" {
  description = "KEK rotation period. Rotation rewraps 32-byte DEKs only, never user payloads."
  type        = number
  default     = 90
}

variable "image" {
  description = "Container image for the backend, e.g. asia-south1-docker.pkg.dev/PROJECT/synap/backend:v1"
  type        = string
}

variable "min_instances" {
  description = "Set to 1 to avoid cold starts on the upload path once there is real traffic."
  type        = number
  default     = 0
}

variable "speaker_enabled" {
  description = "Create the private Synap speaker-verification Cloud Run service. Disabled by default so existing environments remain unchanged until a speaker image has been built."
  type        = bool
  default     = false
}

variable "speaker_image" {
  description = "Container image for the optional speaker service. Required when speaker_enabled=true."
  type        = string
  default     = ""

  validation {
    condition     = !var.speaker_enabled || length(trimspace(var.speaker_image)) > 0
    error_message = "speaker_image must be set when speaker_enabled=true."
  }
}

variable "speaker_min_instances" {
  description = "Minimum instances for voice verification. Keep 0 while usage is low; set 1 if enrollment/matching cold starts become noticeable."
  type        = number
  default     = 0
}

variable "billing_account_id" {
  description = "Billing account for the spend alert, e.g. 016546-5B939B-08B03B. Leave empty to skip creating a budget."
  type        = string
  default     = ""
}

variable "monthly_budget_inr" {
  description = "Monthly spend that triggers alerts. Transcription dominates the bill, so set this to a number you would actually be unhappy to see."
  type        = number
  default     = 2000
}
