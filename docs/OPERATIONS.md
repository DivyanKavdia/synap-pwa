# Synap operations and recovery

**Reviewed: 7 October 2026**

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
The firmware repository publishes an OTA feed for **three build targets and four functional variants**. On 7 October 2026 the Odyssey C3 manifest reports **Synap OS build 1838**, source commit `978b44a8cc8b4c4b270fd15c396c1ab740d92008`. Standard C3 and C3 + SD share the same C3 image. Read each target manifest before quoting the current S3/Chakshu version.

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

## 6. SD troubleshooting by variant

### Odyssey C3

**Standard C3:** missing/unmounted SD is not a BLE audio failure. Connected audio must remain usable without a card.

**C3 + SD:** the canonical firmware implementation is documented in [Odyssey C3 SD architecture](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/ODYSSEY_C3_SD_AUDIO.md). Do not troubleshoot it using Chakshu clocks/pins or the older abandoned native-SDSPI/preallocation design.

The validated C3 path uses:

- Arduino-ESP32 3.3.5 SD/SPI;
- retained runtime clock 1 MHz;
- 4 KiB multi-sector recording writes;
- append-only STOP behavior;
- virtual WAV-header synthesis during transfer;
- bounded CMD18/CMD25 re-arm;
- C3-only CMD24 busy-completion patch.

Healthy capability diagnostics are:

```json
{
  "sdDetectionState": 1,
  "sdProbeState": 6,
  "sdLiveProbeState": 6,
  "lastRecordKiB": 0
}
```

Interpret the fields separately:

- `sdDetectionState` — current card/mount state snapshot;
- `sdProbeState` — persisted recorder failure stage when present, otherwise probe state;
- `sdLiveProbeState` — current mount/probe state even when historical failure evidence is retained;
- `lastRecordKiB` — approximate successfully written PCM before the persisted recorder failure.

A historical `sdProbeState` is not proof the current card is still unhealthy if `sdLiveProbeState` is 6.

Useful recorder stages for field diagnosis:

- 40 — storage guard/not-ready fallback;
- 41 — path failure;
- 42 — stream setup failure;
- 43 — microphone/I2S failure;
- 47 — close/metadata commit failure;
- 48 — zero PCM;
- 49–54 — file-create errno classes;
- 66–70 — 4 KiB batch-write errno classes.

Older upgraded devices can still report stages from earlier validation builds. Always record the installed firmware build with the stage.

Offline double tap starts/stops WAV with a purple pulse. Normal connected capture uses the BLE path. Catalogue/file chunk reads carry an explicit path on every operation-4 request; `@catalogue` is reserved for catalogue bytes. Operation 14 is explicit storage recovery.

### C3 sync troubleshooting

Treat sync as two separate transactions:

1. **durability** — download → local import → verification → persisted receipt;
2. **retention** — keep or explicitly delete the SD source.

After successful durability verification, a retained source must show **Synced to Memories · Also on device SD**. It must not return to **Sync to Memories** and must not be imported a second time.

If a synced file remains on SD, that is not a failed sync. The user can choose **Delete from SD** immediately after sync or later. Deleting the SD copy must not delete the Memory.

If sync fails, distinguish:

1. live SD mount/readiness;
2. BLE media request/queue;
3. byte download;
4. durable local import;
5. verification/receipt persistence;
6. optional SD deletion;
7. later cloud transcription/understanding.

A transcription/provider failure after a verified local import is not an SD sync failure.

### Chakshu

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
- SD deletion is owned by `devices/chakshu/capture-preview.js`; `devices/chakshu/media.js` must not issue media operation 17 directly.

Do not mix these Chakshu-specific recovery clocks or GPIO assumptions with Odyssey C3.

## 7. BLE recovery

A browser/peripheral disconnect is not an app-requested disconnect unless diagnostics say so. Reconnect must establish a fresh connection/session generation before module/media state is trusted.

For Chakshu:
- Hey Snap remains armed across BLE connect/disconnect while PWA recording is idle;
- an admitted PWA audio/video START suspends the Hey Snap listener and competing media actions;
- voice Stop affects only voice/TTP-owned SD media and never stops a PWA-owned capture.

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
- standard C3 BLE recording with no card; C3 + SD cold boot, offline double-tap start/stop, purple pulse and green connected capture;
- C3 + SD reconnect during recording, PWA START handoff, verified sync and failed-sync original retention;
- C3 retained synced-copy state, duplicate-import prevention, explicit Delete from SD before/after sync and Memory preservation after SD deletion;
- SD cold boot and re-detection;
- offline photo/video/audio creation;
- verified sync plus explicit keep/delete retention choice;
- transcript → memory → Ask provenance;
- OTA target validation.


### Bluefy/iOS recording recovery

Foreground audio-stall recovery reuses the existing audio notification subscription and requests buffered replay directly. It does not rewrite the CCCD while the live Bluefy link is congested. After repeated immediate native Bluetooth reason-2 failures, Synap recognizes the permitted device wrapper as stale, refreshes it once through `navigator.bluetooth.getDevices()` without opening a chooser, and only then falls back to explicit device reselection if the refreshed handle also fails. The recording journal remains preserved throughout the reconnect grace period.

### Odyssey C3 SD and PWA device controls — current

Device settings retain the Odyssey startup/live SD diagnostics as evidence, not as a substitute for actual current storage readiness. **S3** only performs its own detection behavior; **standard C3** continues BLE audio without storage; **C3 + SD** supports offline WAV recording and media-v1 catalogue/sync when the card is healthy.

The current checked-in PWA shell is `1.0.0-shell191-c3-offline-status`. Static SD UI assets are cache-busted independently, so after a retention/sync UI deployment Bluefy may need a full close/reopen to load the new script revision.

Current C3 sync diagnostics separate catalogue discovery, download, durable import, verification/receipt persistence and optional SD deletion. Successful sync does **not** imply deletion: a retained source is intentionally shown as already synced and remains deletable later through **Delete from SD**.

A Bluefy saved-handle `Operation failed (code 2)` followed by successful explicit device reselection is a browser Bluetooth permission/handle issue, not evidence of SD failure.
