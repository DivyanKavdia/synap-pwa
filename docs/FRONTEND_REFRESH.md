# Frontend refresh

Previews: [phone](frontend-refresh-mobile.png) · [desktop](frontend-refresh-desktop.png).
These show a fresh local profile in headless Chromium, which has no Web Bluetooth
adapter. No user recordings or connected device are represented.

The refresh changes presentation, not the pendant or recording protocol. It keeps
all primary sections mounted and preserves the existing recording, journal,
reconnect, processing, account, and OTA owners.

- Mint and deep-green semantic palettes, with light/dark contrast tests.
- A desktop navigation rail and two-column overview; a safe-area-aware phone dock.
- A dedicated recorder, full-width Start/Stop controls, and the agreed gesture guide:
  double tap records on/off; triple tap sleeps/wakes.
- Restyled briefs, decisions, conversations, people, Ask, audio cards, and Settings.
- Keyboard focus on navigation, larger touch targets, reduced-motion support,
  and visible firmware status without exposing inactive OTA controls.
- `compact.css` is the final scoped presentation stylesheet, loaded exactly once
  after the legacy base styles. `dashboard-ui.js` owns navigation, not the palette.
- Shell cache generation `1.0.0-shell37-refresh`; BLE client compatibility remains
  unchanged. No automatic reload, storage migration, or firmware update is added.

## Verification

`node --test tests/*.cjs` runs the dependency-free regressions.

`node tools/ui-smoke.cjs` additionally requires Playwright and its Chromium browser
to be installed and resolvable by Node. It starts a localhost-only server, blocks
external browser requests, and checks 320/390/768/1440px in light and dark mode.
It also uses an isolated sample recording to test local search, playable WAV,
export, and grounded local Ask. Optional `SYNAP_CHROMIUM_PATH` chooses an installed
browser and `SYNAP_UI_OUTPUT` chooses the screenshot directory.

These tests do not replace physical pendant testing: connect/reconnect, tap-start
and tap-stop, triple-tap sleep/wake, live audio, interruption recovery, and OTA
still need a compatible browser and real device before production promotion.
