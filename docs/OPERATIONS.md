# Synap operations and recovery

**Reviewed: 22 September 2026**

## 1. Release truth

### PWA
GitHub Pages publishes `main`. The service-worker shell revision describes client-cache generation; it is not a firmware/API protocol version.

### Backend
Backend-affecting changes on `main` run the production workflow:
1. install dependencies;
2. typecheck and test;
3. build/deploy a candidate Cloud Run revision;
4. run readiness against production dependencies;
5. promote verified traffic;
6. retain rollback information if promotion fails.

### Firmware
The firmware repository publishes an OTA feed. At this review the verified production feed reports **Synap OS build 1402** for all three targets, source commit `e63af76e2c8a764109f4d572d26b4b71ce7787c7`.

Never infer installed device behavior from a newer firmware `main` commit.

## 2. Required checks before merge

```sh
npm test
npm run typecheck
npm run test:backend
npm run test:browser
```

Production validation additionally covers Firestore integration, WebKit audio, browser workflows and infrastructure contracts.

## 3. Processing troubleshooting

### Transcript exists but UI says Processing

The UI now reconciles saved content against stale processing metadata:
- transcript present + stale `uploaded/transcribing` → show summarizing/understanding;
- structured memory/summary present → show Ready.

If a specific recording remains stuck:
1. open diagnostics and record recording ID/state/stage;
2. confirm whether transcript and/or memory are already saved;
3. refresh cloud history/source;
4. use Retry only for a genuinely retryable failed/uploaded cloud state;
5. do not re-upload or re-transcribe merely to fix a stale badge.

### Provider cooldown/rate limit

Saved source audio and completed segment transcripts are retained. A cooldown is durable scheduling state, not data loss. Repeated manual retries before the provider deadline should be avoided.

## 4. Ask Synap troubleshooting

Cloud Ask uses bounded semantic + transcript evidence. One unreadable historical recording is skipped rather than failing the query.

If cloud Ask fails for a non-validation error, the PWA falls back to local recall and labels the result accordingly.

Investigate persistent cloud failures in this order:
1. auth/session;
2. Cloud Run readiness;
3. retrieval/index availability;
4. Gemini/provider diagnostics;
5. malformed/unreadable historical record isolation.

Do not disable the local fallback to make a cloud failure more visible; diagnostics should expose the cloud fault while recall remains useful.

## 5. Speaker/name corrections

### One recording
Use **Edit speaker identity**. Saving:
- updates label→name mapping;
- refreshes the transcript;
- regenerates memory/indexed derivatives;
- does not re-transcribe audio.

### One person across history
Use **People → Edit name**. The backend updates the canonical profile and relevant speaker mappings, returns affected recording IDs, and the client rehydrates them.

Modern propagation is scoped by canonical person ID to avoid corrupting two different people who share a name.

## 6. Chakshu SD troubleshooting

Key diagnostics:
- `sdReady`
- `sdClockHz`
- `sdMountStage`
- `sdMountAttempts`
- `sdRecoveryLocked`
- `freeHeap`

Rules:
- catalogue/reconnect is non-destructive;
- cold detection tries 10 → 4 → 1 MHz;
- post-mount I/O recovery locks to conservative 1 MHz for that boot;
- failed sync retains the SD original;
- Clear SD removes only Synap-owned capture patterns and never formats the card;
- verified source deletion is owned only by `devices/chakshu/capture-preview.js`; `devices/chakshu/media.js` must not issue media operation 17 directly.

When SD fails during sync, separate:
1. mount/readiness failure;
2. BLE/media queue interruption;
3. copy/digest verification failure;
4. cloud processing after import.

Do not conflate an API transcription failure with an SD capture/transfer failure.

## 7. BLE recovery

A browser/peripheral disconnect is not an app-requested disconnect unless diagnostics say so. Reconnect must establish a fresh connection/session generation before module/media state is trusted.

For Chakshu:
- connect/disconnect does **not** stand Hey Snap down; the wake engine remains available in both BLE states;
- the PWA subscribes once to voice-result notifications and uses idempotent voice-on for compatibility;
- Hey Snap media remains SD-owned while PWA/TTP live capture remains phone-owned;
- a BLE transition must not invalidate queued local voice work merely because ownership changed;
- conflicting media still respects the shared resource-admission gates and returns busy rather than overlapping writers.

## 8. Deployment rollback

### PWA
Use the last known-good commit as the rollback source, then let Pages publish it normally. Do not change BLE compatibility identifiers merely to roll back UI code.

### Backend
Use the Cloud Run revision/rollback instructions emitted by the deploy workflow. A candidate should not receive production traffic until readiness passes.

### Firmware
Rollback only with a target-compatible signed/published artifact and normal OTA image/target verification. Never flash another target's binary.

## 9. Production readiness boundary

Readiness proves the cloud pipeline and dependencies with synthetic/non-user data. It does not inspect user conversations and does not replace device acceptance.

## 10. Acceptance after device-affecting changes

Record exact PWA shell + installed firmware build and verify:
- sustained audio capture;
- background/lock recovery;
- reconnect;
- Chakshu owner handoff;
- TTP223 GPIO1 / D0 double-tap and 4-second deep-sleep/wake behavior;
- GPIO2 / D1 battery percentage/raw telemetry with the 1 MΩ / 470 kΩ divider;
- GPIO5 / D4 NeoPixel status behavior without any writes to SD CS GPIO21;
- SD cold boot and re-detection;
- offline photo/video/audio creation;
- verified sync and source deletion;
- transcript → memory → Ask provenance;
- OTA target validation.


### Bluefy/iOS recording recovery

Foreground audio-stall recovery reuses the existing audio notification subscription and requests buffered replay directly. It does not rewrite the CCCD while the live Bluefy link is congested. After repeated immediate native Bluetooth reason-2 failures, Synap recognizes the permitted device wrapper as stale, refreshes it once through `navigator.bluetooth.getDevices()` without opening a chooser, and only then falls back to explicit device reselection if the refreshed handle also fails. The recording journal remains preserved throughout the reconnect grace period.
