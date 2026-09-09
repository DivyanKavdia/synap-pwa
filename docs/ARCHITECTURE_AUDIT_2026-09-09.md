# Synap architecture audit — 2026-09-09

## Scope

This audit covers the production PWA, BLE/session lifecycle, recording continuity, IndexedDB journal, processing/event model, cloud-history hydration, transcript/action UI, service-worker bootstrap, backend route/pipeline structure and the production firmware handoff.

## Executive findings

The backend processing pipeline is structurally healthy: Cloud Tasks are mounted before blanket user-auth routers, recording processing is restart-safe, already-transcribed segments are reused, memory/indexing are durable, and model responsibilities are separated.

The highest production risk was in the PWA runtime. Functionality had accumulated as independent compatibility layers, creating duplicate ownership and non-deterministic startup:

1. `index.html` loaded only part of the product while the service worker cached a larger module graph and other scripts dynamically injected missing modules.
2. Hardware-started recording could be adopted by three paths (`runtime-ui`, `recording-bridge`, and the power helper), allowing double Start actions/races.
3. Navigation had two owners (`runtime-ui` and `dashboard-ui`).
4. Deep-sleep/reconnect preference was managed by both `recording-bridge` and `sleep-state-guard`.
5. `app.js` stopped automatic reconnect after three attempts (~9 seconds) while capture continuity allowed two minutes to resume. The two policies contradicted each other.
6. Several UI modules used broad `MutationObserver`s as a data-change mechanism. This caused unnecessary IndexedDB reads/re-rendering and contributed to iOS/WebKit repaint flicker.
7. `product-ui` recreated an “Advanced & recovery” section that another module immediately hid, leaving dead product behavior and unnecessary DOM work.
8. The service-worker cache revision had not advanced with recent architecture/UI changes, making offline startup more prone to mixed-generation modules.

## Ownership model after stabilization

| Responsibility | Single owner | Supporting modules |
| --- | --- | --- |
| BLE connect/GATT/reconnect | `app.js` | `device-identity.js`, `event-channel.js` |
| Raw audio collection/session state | `app.js` | `audio-codec-v3.js` |
| Durable local audio journal | `audio-store.js` | `capture-stability.js`, rolling-window wrapper |
| Hardware-started stream adoption / long rollover | `recording-bridge.js` | none |
| Intentional deep-sleep reconnect lock | `sleep-state-guard.js` | `recording-bridge.js` consumes its event |
| BLE power/standby command | power helper in `battery-popover-fix.js` | does not start recordings when recording bridge exists |
| Processing queue | `DKFIFOProcessor` + `synap-backend.js` | `processing-pipeline-ui.js` |
| Cloud history hydration | `cloud-history.js` | targeted recording transcript fetch |
| Memory/transcript presentation | `memory-tools.js` | `brain-ui.js` |
| Today/Actions data presentation | `brain-ui.js` | explicit memory events |
| Primary navigation/view state | `dashboard-ui.js` | `runtime-ui.js` falls back only if dashboard unavailable |
| Firmware OTA | `ota.js` + `releases.js` | production `ota-releases` manifest |
| Backend orchestration | Cloud Tasks + `pipeline/process.ts` | Firestore/GCS/KMS/Gemini |

## Changes made in this stabilization

### Deterministic PWA bootstrap

All core product modules are explicitly loaded by `index.html` exactly once and in dependency order. Dynamic loaders remain only as backwards-compatible fallbacks and are disabled when the deterministic production bootstrap flag is present.

This makes a fresh browser, an installed PWA, and an upgraded PWA execute the same module graph.

### Reconnect policy

Automatic reconnect remains owned by `app.js`, but its backoff horizon is extended to roughly two minutes. This aligns with the capture-continuity resume window. No secondary Connect-click loop is introduced.

Intentional deep sleep still disables reconnect so the longer retry horizon cannot wake/fight a deliberately sleeping pendant.

### Single hardware stream adoption

`recording-bridge.js` is the production owner for converting a firmware-started stream into a local PWA recording. Runtime UI and power helper paths defer when the bridge is installed.

### Single deep-sleep preference owner

`sleep-state-guard.js` owns the durable auto-reconnect lock and emits canonical `synap-intentional-sleep` state. `recording-bridge.js` consumes that state for rollover/adoption behavior and no longer needs to compete for the power packet in the normal production graph.

### Event-driven rendering

Today/Actions/daily-brief/dashboard refreshes use explicit domain events such as:

- `synap-memory-ready`
- `synap-cloud-history-updated`
- `synap-transcript-updated`
- `synap-processing-state`
- date changes

Broad document/Insights mutation observers are removed from data-flow responsibilities. This reduces iOS/WebKit repaint churn and makes UI refresh causality observable.

### Product recovery controls

The removed “Advanced & recovery” product section is no longer recreated. Low-level controls remain in the DOM only for internal compatibility with the recorder/processor and stay hidden from normal product UX.

### Service-worker generation

The cache revision advances with the new module graph. Source files remain network-first when online with an offline shell fallback.

## Backend review

The backend did not require structural changes in this pass.

Positive findings:

- exact-origin CORS allowlist;
- no-store/security headers;
- Cloud Tasks routes mounted before blanket authenticated routers;
- route-scoped Ask v2 authentication;
- Firestore-backed unauthenticated rate limiting;
- restart-safe transcription with sealed-segment reuse;
- encrypted memory/transcript storage;
- embeddings degrade gracefully rather than failing a memory;
- daily brief has already been changed to avoid repeated expensive LLM regeneration;
- separated low-cost extraction/query parsing and higher-quality final grounded Ask answering.

## Firmware review

Production OTA currently points to S3 build 1152 from the `ota-releases` branch. The firmware already exposes diagnostics for capture drops, notification rejects, control drops, reset reason, heap and uptime, and restarts advertising after a GATT disconnect.

No firmware change is included in this PWA architecture stabilization because duplicate browser ownership and short reconnect policy must be eliminated first. If physical testing after this deployment still shows genuine GATT disconnects, the next firmware-focused pass should use diagnostics to distinguish:

- RF/GATT disconnect;
- notification rejection/backpressure;
- capture queue drops;
- brownout/watchdog reset;
- browser suspension.

Only then should connection parameters, notification pacing/backpressure, or firmware buffering be changed.

## Release gates

The architecture regression suite must enforce:

- one deterministic production script graph;
- service-worker/index shell consistency;
- one GATT reconnect owner;
- one hardware stream adoption owner;
- one deep-sleep reconnect-lock owner;
- reconnect horizon aligned to capture continuity;
- no timer-driven or whole-document data refresh loops;
- no recreation of the Advanced & recovery section;
- existing PWA regressions and backend typecheck/tests remain green.

## Remaining design debt (non-blocking)

`app.js` is still a large monolith. Splitting it into typed modules/state machines would improve long-term maintainability, but doing that concurrently with BLE production stabilization would create unnecessary regression risk. The stabilized ownership boundaries in this document should be used as the future extraction seams.

A future phase can extract:

1. `BleSessionController`
2. `RecordingSessionController`
3. `RecordingRepository`
4. `ProcessingCoordinator`
5. `UiProjectionStore`

without changing the external behavior validated in this release.
