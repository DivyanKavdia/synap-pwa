# Synap authentication compatibility

Synap uses a capability-aware authentication strategy so authentication and Bluetooth support can evolve independently.

| Environment | Authentication | Bluetooth |
| --- | --- | --- |
| Android Chrome / Chromium PWA | Google Identity Services in the same browser | Native Web Bluetooth when available |
| Desktop Chrome / Edge | Google Identity Services in the same browser | Native Web Bluetooth when available |
| iPhone/iPad in Bluefy or another Web-Bluetooth browser | Safari pairing flow: Google authentication completes in the system browser, then the Bluefy session claims a short-lived Synap session | Bluefy Web Bluetooth |
| Safari on iPhone/iPad | Google Identity Services/system-browser-compatible flow | No dependency on Bluetooth support |

Principles:

- Never disable Google 2FA or weaken OAuth security to make an embedded iOS browser work.
- Do not pass access or refresh tokens in URLs.
- Keep the pairing transaction short-lived, single-use and bound to an unguessable claimant secret retained only by the initiating browser.
- Keep the existing Google Identity Services flow for Android and desktop; iOS pairing is an additional path, not a replacement.
- Detect capabilities/platform at runtime rather than maintaining separate Android and iOS application builds.

For normal Synap processing, select **Synap Cloud** in **Settings → Memory & AI →
Processing options** and sign in with Google. Its session refreshes automatically.
The queue reports `Uploading audio` while sending a segment through that account.

**Custom endpoints** use a separate, manually supplied access token. That token
stays in memory and must be entered again after a reload. A custom HTTP 401/403
now explains which setting to correct; retrying alone cannot repair credentials.
Synap API addresses are rejected in custom mode before audio is sent because
their upload protocol and authentication require the managed Synap provider.
This leaves jobs pending and retains their saved audio. Diagnostics identify the
selected provider and HTTP status without exposing tokens or endpoint URLs.
