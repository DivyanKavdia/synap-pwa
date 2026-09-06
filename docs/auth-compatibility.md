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
