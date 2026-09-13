# Deploying the Synap backend on GCP

From an empty project to a working second brain. Budget about 40 minutes, most
of it waiting for API enablement and the first Cloud Run build.

## What gets created

| Component | Purpose |
| --- | --- |
| Cloud Run `synap-backend` | The `/v1` API |
| Firestore (native) | Structured memory, people, follow-ups, daily briefs |
| Cloud Storage `PROJECT-synap-audio` | Sealed audio segments, CMEK, 30-day lifecycle |
| Cloud KMS `synap/user-kek` | Wraps every user's data encryption key |
| Cloud KMS `synap/audio-storage` | Bucket CMEK |
| Secret Manager | Gemini AI Studio key, session signing key |
| Cloud Tasks `synap-processing` | Transcription and memory extraction queue |
| Two service accounts | API identity, and the Cloud Tasks OIDC caller |

## 0. Install the tools

```bash
# macOS
brew install --cask google-cloud-sdk
brew install terraform node

gcloud auth login
gcloud auth application-default login
```

Node 22 or newer. Then create the project and link billing — nothing below
works without an active billing account, and the error you get three steps
later will name an unrelated API:

```bash
gcloud projects create synap-prod --name="Synap"
gcloud billing accounts list                       # copy the ACCOUNT_ID
gcloud billing projects link synap-prod --billing-account=ACCOUNT_ID
```

Use your own project id — `synap-prod` is likely taken, ids are globally
unique.

## 1. Two things you must click for (everything else is scripted)

### 1a. The Gemini AI Studio key

Go to https://aistudio.google.com/apikey → **Create API key** → pick your
project. Copy it somewhere temporary; you paste it into Secret Manager in
step 3 and then forget it.

### 1b. The OAuth consent screen and client ID

This is the fiddly part, and the only place people reliably get stuck.

**Consent screen** — Cloud Console → **APIs & Services → OAuth consent screen**:

- User type: **External**
- App name, support email, developer contact: your own
- **Scopes: add nothing.** Google Identity Services returns an ID token using
  only `openid`, `email` and `profile`, which are non-sensitive. Adding no
  scopes is what keeps you out of Google's verification review entirely.
- Publishing status: leave it on **Testing** and add yourself under **Test
  users**.

> Testing mode caps you at 100 test users and expires *Google* refresh tokens
> after 7 days. That second limit does not apply here: Synap takes a one-shot
> Google ID token and mints its own session, so it never holds a Google refresh
> token. You can stay in Testing indefinitely while it is just you. Publish when
> you want anyone with a Google account to sign in.

**Client ID** — **APIs & Services → Credentials → Create credentials → OAuth
client ID → Web application**:

- Authorized JavaScript origins:
  - `https://divyankavdia.github.io`
  - `http://localhost:8000` (for local development)
- Authorized redirect URIs: **leave empty.** Google Identity Services uses the
  implicit ID-token flow. A redirect URI here is a common misconfiguration that
  produces confusing errors later.

Copy the client ID (`...apps.googleusercontent.com`). It is not a secret — it
ships inside the PWA.

> The origin must match **exactly**, scheme and all. `https://divyankavdia.github.io`
> works; a trailing slash or a `/synap-pwa` path does not. Origins are
> scheme + host + port, never a path.

> **Working in Cloud Shell?** Only your home directory survives a VM recycle —
> `/usr` does not, so `apt install terraform` disappears without warning and the
> shell then reports `terraform: command not found` as if it were never there.
> Install the binary into `~/bin` instead:
>
> ```bash
> mkdir -p ~/bin && cd /tmp \
>   && curl -sLO https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_linux_amd64.zip \
>   && unzip -o terraform_1.9.8_linux_amd64.zip terraform -d ~/bin && cd -
> echo 'export PATH="$HOME/bin:$PATH"' >> ~/.customize_environment
> export PATH="$HOME/bin:$PATH"
> ```

## 2. Bootstrap and provision

```bash
PROJECT_ID=synap-prod ./infra/bootstrap.sh
```

This checks billing, enables the build APIs, creates the Artifact Registry
repository, runs the backend tests and pushes a first image — solving the
chicken-and-egg where Terraform wants a Cloud Run service and Cloud Run wants
an image that does not exist yet. It prints the image tag for the next command.

```bash
cd infra/terraform
terraform init
terraform apply \
  -var project_id=synap-prod \
  -var google_client_id=YOUR_CLIENT_ID.apps.googleusercontent.com \
  -var image=THE_IMAGE_TAG_BOOTSTRAP_PRINTED
```

Expect roughly 5 minutes, most of it API enablement and Firestore creation.

## 3. Add the Gemini key and pin the service URL

> Terraform seeds the Gemini secret with a placeholder version, because Cloud
> Run resolves secrets at boot and exits if one has no version at all — without
> it the first apply dies on a startup probe failure that reads as a broken
> container. Replace the placeholder before expecting any transcription to work;
> the service logs a loud ERROR on every boot until you do.

```bash
printf '%s' "YOUR_GEMINI_API_KEY" | \
  gcloud secrets versions add synap-gemini-api-key --data-file=- --project=synap-prod

URL=$(gcloud run services describe synap-backend --region=asia-south1 \
  --project=synap-prod --format='value(status.url)')

gcloud run services update synap-backend --region=asia-south1 \
  --project=synap-prod --update-env-vars="SYNAP_SERVICE_URL=$URL"

echo "$URL"
```

`SYNAP_SERVICE_URL` has to be set after the first deploy because Cloud Tasks
calls the service back at its own address, and that address only exists once
Cloud Run has created it.

The session signing key is generated by Terraform. Nobody needs to see it.

## 4. Every deploy after this one

```bash
PROJECT_ID=synap-prod ./infra/deploy.sh
```

Tests, builds, deploys, re-pins the URL. Use this from now on; `bootstrap.sh`
is a one-time thing.

## 5. Point the PWA at it

In the PWA: **Settings → Memory & AI → Connection**. Paste the Cloud Run URL and
the OAuth client ID, then **Sign in**.

To bake them in instead of asking every user, edit the `DEFAULTS` object at the
top of `google-auth.js`:

```js
var DEFAULTS = {
  clientId: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
  backendUrl: 'https://synap-backend-xxxx.a.run.app'
};
```

Bump `CACHE_REVISION` in `sw.js` when you do, or installed clients keep the old
shell.

## 6. Verify end to end

```bash
URL=$(gcloud run services describe synap-backend --region=asia-south1 --format='value(status.url)')
curl -fsS "$URL/health"
```

Then, from a phone: record 30 seconds through the pendant, stop, and watch
Settings → Diagnostics. The queue should report upload, then "synap is
understanding this conversation", then a summary in Memories. First run takes
longer because Cloud Run is cold and the Firestore vector index is still
building.

## Spend alerting

Nothing in this stack caps cost, and transcription is billed per minute of
audio. Pass your billing account to get budget alerts at 50%, 90%, 100% and on
forecast:

```bash
terraform apply ... -var billing_account_id=016546-5B939B-08B03B -var monthly_budget_inr=2000
```

Alerts make a runaway visible within a day. They do not stop it — capping spend
needs a billing-triggered function, which is deliberately not wired up here
because a hard cutoff mid-capture loses recordings.

## Indexes created by hand

If an index was created from a Firestore error link or with `gcloud` before
Terraform knew about it, `apply` fails with `ALREADY_EXISTS`. Import rather than
delete — rebuilding a vector index takes minutes:

```bash
P=YOUR_PROJECT_ID
for r in recordings_by_day conversations_by_day conversation_vectors_plain; do
  echo "terraform import google_firestore_index.$r <index resource name>"
done
gcloud firestore indexes composite list --project=$P --format='value(name)'
```

Match each resource to its index by collection group and fields, then import
with the full `projects/.../indexes/...` name.

## First-run errors, in the order you are likely to hit them

| Symptom | Cause and fix |
| --- | --- |
| `PERMISSION_DENIED` enabling any API | Billing is not linked. `bootstrap.sh` checks this first for exactly this reason. |
| Terraform: `Error 409: Database already exists` | A Firestore database exists from an earlier attempt. Import it: `terraform import google_firestore_database.synap projects/PROJECT/databases/(default)` |
| Sign-in popup closes instantly, console shows `origin_mismatch` | The JavaScript origin does not match exactly. Scheme + host + port, no trailing slash, no path. |
| `idpiframe_initialization_failed` | Third-party cookies are blocked, or the client ID is wrong. Test in a normal window before blaming the config. |
| Sign-in works, `/v1` calls fail with CORS errors | `SYNAP_ALLOWED_ORIGINS` does not include the PWA origin. It is an exact allowlist by design — no wildcards on an API holding someone's recorded life. |
| `403 access_denied` at sign-in | You are in Testing mode and this account is not a test user. Add it, or publish the consent screen. |
| Upload succeeds, processing sits at `uploaded` forever | `SYNAP_SERVICE_URL` is unset, so no Cloud Task was enqueued. Re-run step 3. |
| Processing fails with Gemini HTTP 400 | Read the stage and model in the error. Transcription validates language hints and tries bounded option recovery; a persistent 400 needs the provider error and audio/request validation. Check API-key configuration only when the error indicates authentication. Use **Retry processing** to retain the saved audio. |
| Ask Synap returns nothing but recordings exist | The Firestore vector index is still building. Retrieval falls back to recency meanwhile. Check index status in the Console. |

## Costs

Rough monthly figures for one heavy user (about two hours of audio a day):

| Service | Estimate |
| --- | --- |
| Gemini transcription | the dominant line item; check current per-minute audio pricing |
| Gemini memory extraction | modest — it runs on transcripts, not audio |
| Cloud Run | near zero at `min_instances = 0` |
| Firestore | a few cents |
| Cloud Storage | a few cents at 30-day retention |
| Cloud KMS | ~$0.06 per key version, plus per-operation cost the DEK cache mostly avoids |

Transcription dominates. If cost becomes the constraint, the first lever is
voice-activity detection before upload — ambient capture is mostly silence, and
not paying to transcribe it is the single biggest saving available.

## Operations

**Where things go wrong first.** Check `/v1/recordings/{id}/processing`. The
`state` field says which stage stalled and `error_code` says why.

**A stuck queue.** Cloud Tasks retries five times with backoff. After that the
task is dead-lettered and the recording sits in `failed` with
`retryable: true` if a retry could plausibly help. The PWA's Retry button
re-enqueues it.

**Vector search returning nothing.** The Firestore vector index takes minutes to
build and `findNearest` fails until it exists. The backend falls back to recency
plus filters, so Ask Synap degrades rather than breaking. Check index status in
the console.

**Rotating the Gemini key.** Add a new secret version and redeploy. Secrets are
read once at boot, so a running revision keeps the old key until it is replaced.

**Revoking a user's sessions.** `POST /v1/auth/signout` bumps their token
generation, invalidating every outstanding refresh token everywhere.

## Local development

```bash
cd backend
npm install
export GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
export SYNAP_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
export SYNAP_AUDIO_BUCKET=YOUR_PROJECT_ID-synap-audio
export SYNAP_GEMINI_API_KEY=...          # bypasses Secret Manager
export SYNAP_SESSION_SIGNING_KEY=$(openssl rand -base64 32)
export SYNAP_ALLOWED_ORIGINS=http://localhost:8000
gcloud auth application-default login
npm run build && npm start
```

With no `SYNAP_SERVICE_URL` set, finalize processes the recording inline instead
of enqueuing a Cloud Task, which is what you want on a laptop.

Serve the PWA over HTTP on localhost — Web Bluetooth and service workers both
treat `localhost` as a secure context:

```bash
python3 -m http.server 8000
```
