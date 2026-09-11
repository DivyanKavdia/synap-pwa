# PWA cleanup and connection stability

Validation scope correction: this pass did not complete merge/unmerge journeys. The subsequent [memory workflow repair](MEMORY_WORKFLOW_REPAIR.md) documents the reproduced failures, fixes and added browser deployment checks. Source-contract checks alone do not establish that a user workflow works.

This pass audits the PWA's startup graph, recording path, Bluetooth ownership, processing locks and runtime rendering. It removes obsolete browser code while preserving the production features. Firmware and backend behavior are unchanged.

## Connection fixes

- Event subscriptions, retained event reads, diagnostics and standby writes now use the same serialized GATT queue as recording commands and OTA. They previously bypassed it. Each service context is tied to its connection and is cleared on disconnect; late work from an old connection is rejected.
- Event subscription attempts are deduplicated, bounded and cleaned up on disconnect. A missing EVENT characteristic does not trigger an EVENT retry loop; core control and audio characteristics remain available.
- Recording reconnect retries continue at the capped delay while the existing five-minute recovery window remains open. Discovery and queued START commands recheck the recording session so expired/saved recordings cannot be restarted by late queued work. Idle reconnect stays bounded. User disconnect, auto-reconnect preference and intentional sleep still stop automatic attempts.
- Standby's busy flag previously caused its own eligibility check to fail. The corrected write is queued and checks that the device is still idle when the queued operation executes.
- The recorder owns foreground recovery timing. The global `setInterval` interception is removed; the existing effective twelve-second foreground grace is explicit in app.js.

Serializing operations and discarding disconnected GATT attributes follow the [Chrome Web Bluetooth guidance](https://developer.chrome.com/docs/capabilities/bluetooth). These changes address browser-side races; radio range, pendant power and operating-system suspension still require physical-device validation. They do not guarantee uninterrupted capture when the browser cannot receive audio.

## Cleanup and performance

- index.html owns product scripts and styles, including the modules previously injected by theme.js. Redundant loaders in theme, touch, power and cloud modules are removed. AI provider settings already exist in the production HTML, so the unused alternate settings builder is removed.
- The recording bridge only adopts hardware-started streams. Duplicate sleep preference handling and obsolete synthetic-rollover APIs are removed; sleep-state-guard.js remains the sleep owner.
- The appearance script no longer installs a no-op Web Locks replacement that prevented runtime-compat.js from installing its lease-based fallback. The fallback also prevents overlapping requests from its own page.
- The document-wide brand text rewrite is removed. User transcripts and names keep their original capitalization, and dynamic DOM changes no longer trigger a whole-document casing observer.
- Audio metric updates are batched, the clock only writes changed seconds, and hidden canvases skip waveform geometry and painting.
- Duplicate-frame history is bounded to 512 frames. Previously it retained all 65,536 sequence numbers and would reject new frames after the firmware counter wrapped. The journal's existing sequence normalizer continues appending those frames to the same recording.
- Stale comments, divider boilerplate and the no-op codec installer are removed. Protocol identifiers, historical data migrations and browser compatibility paths that are still used are retained.

Changed runtime files are approximately 16 KB smaller in aggregate, including the connection fixes. Audio journal schema, PCM/ADPCM formats, source links, palettes, automatic appearance, OTA target checks and double/triple-tap meanings remain intact.

## Verification

- All 195 PWA tests pass, including new behavior checks for queued Bluetooth operations, stale connection rejection, cancelled standby, retry bounds, recovery expiry, frame-counter wrap, hardware adoption and processing-lock exclusion.
- Full browser regression passes at 320, 390, 768 and 1440 px in both light and dark modes. It covers day/week navigation, expanded reading, People, source links, playback/export and recording controls.
- tools/connection-smoke.cjs loads the actual production page with a simulated pendant. It verifies connection, local recording, automatic reconnect into the same journal, saved PCM duration and a maximum of one concurrent GATT operation.
- Service-worker cache generation and changed script URLs advance together. GitHub CI verifies the published commit before merge; Pages deployment is checked after merge.

The browser tests use generated recordings and blocked external requests. They do not measure RF disconnect frequency on a physical pendant. If physical disconnects persist, use the existing disconnect/timeout logs and pendant diagnostics to distinguish browser suspension, GATT timeouts, radio loss and device resets before changing firmware connection parameters.
