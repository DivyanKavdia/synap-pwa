# Synap launch-readiness acceptance

**Baseline: 1 October 2026.** This checklist records gates; it does not claim that a physical device has passed them.

## Release scope

- **PWA:** `synap-pwa/main` publishes GitHub Pages; its shell revision is separate from firmware and API versions.
- **Backend:** typecheck, unit/integration tests, disposable Firestore and candidate Cloud Run readiness precede traffic promotion.
- **Firmware:** `synap-firmware/main` compiles one binary each for Odyssey S3, Odyssey C3 and Chakshu; `ota-releases` is the only installable build authority. Standard C3 and C3 + SD share a binary.

## Automated gate

Run from the appropriate repository:

```sh
# PWA
npm ci
npm ci --prefix backend
npm test
npm run typecheck
npm run test:backend
npm run test:browser

# Firmware
node tools/assemble-source.cjs --check
node --test tests/*.cjs
```

The production workflows additionally build all firmware targets and validate the backend, Firestore, WebKit audio and browser journeys. Verify every workflow run for the specific release commit, published binary SHA-256/provenance, target markers and browser OTA CORS. Compare the PWA `devices/catalog.json` with the firmware's canonical file; `node tools/device-catalog.cjs --check` verifies generated profiles within the PWA repository.

## Required physical acceptance

| Device / path | Evidence required |
| --- | --- |
| Odyssey S3 | BLE pairing, sustained PCM16 audio, reconnect, standby/wake, battery, OTA and SD detection-only behavior. |
| C3 without SD | BLE audio remains available when SD is absent or fails mounting; touch and OTA work. |
| C3 + SD | Cold mount, disconnected double-tap start **and stop**, purple pulse, connected green recording, BLE reconnect during active take, explicit-path chunk transfer, verified PWA import and deletion *only after verification*. |
| Chakshu | BLE audio/photo/video, offline Hey Snap and touch recording, media ownership handoff, GPIO1 touch/GPIO2 battery/GPIO5 NeoPixel, SD recovery and verified synchronization. |
| PWA on iOS/Bluefy | Reconnect and lock/background recovery, Restart Device only when connected/idle and supported, pending-SD catalogue visibility and recoverable failed transfers. |
| Backend/cloud | Encrypted source durability, retry after interruption, transcript provenance, speaker correction, unified-memory source preservation and grounded Ask. |

For failed or interrupted SD sync, confirm the original remains on-card and that an imported recording survives a page refresh. Verify both ordinary PWA refresh and rollback from a known-good Git commit; keep a target-specific USB factory image for an unresponsive device.

## No-go conditions

Do not label a release launch-ready if its commit's automated checks fail, OTA binary/target identity cannot be verified, a recording cannot reliably stop, data is deleted before durable import, the browser cannot reconnect after interruption, or the required physical-device checks are still outstanding. Log the installed firmware build, PWA shell revision, OS/browser, test date, and test operator for each hardware acceptance run.
