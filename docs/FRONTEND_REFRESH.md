# Frontend refresh

Previews: [phone](frontend-refresh-mobile.png) · [desktop](frontend-refresh-desktop.png).
Feedback update: [People — light](ui-feedback-people-light.png) ·
[People — dark](ui-feedback-people-dark.png) · [Library](ui-feedback-library.png) ·
[Settings](ui-feedback-settings.png).
These show a fresh local profile in headless Chromium, which has no Web Bluetooth
adapter. No user recordings or connected device are represented.

The refresh changes presentation, not the pendant or recording protocol. It keeps
all primary sections mounted and preserves the existing recording, journal,
reconnect, processing, account, and OTA owners.

- Mint and deep-green semantic palettes, with light/dark contrast tests.
- The original Synap silhouette is preserved in `synap-logo.svg` as source
  artwork. The live header and Settings use explicit `synap-logo-light.png` /
  `synap-logo-dark.png` exports, selected by the app's actual theme. No embedded
  SVG media query or mask is needed to display the logo. The Settings wordmark
  is 96px wide instead of squeezing the full name into a 36px icon slot.
  `logo.webp` remains original source artwork, not a live UI asset.
- The favicon and installed-app PNGs now share the Synap monogram on deep green,
  including a maskable safe zone. Regenerate PNGs from `icon.svg` with
  `node tools/rasterize-brand.cjs` (requires `sharp`).
- A desktop navigation rail and two-column overview; a safe-area-aware phone dock.
- A dedicated recorder, full-width Start/Stop controls, and the agreed gesture guide:
  double tap records on/off; triple tap sleeps/wakes.
- Restyled briefs, decisions, conversations, people, Ask, audio cards, and Settings.
- Library defaults to All dates, with an explicit Selected day filter. Today and
  Memories still follow the selected date. ID-based reconciliation preserves
  open tiles, native audio players and note edits during source/cloud refreshes.
- People shows three recent entries, then View all opens a bounded, searchable
  list. Grounded recall and canonical identities remain wired; confirm/rename
  controls live in an accessible per-person menu instead of permanent extra rows.
  Rename Save clicks now reach the native form submission instead of being
  swallowed by the control's delegated click handler.
- Keyboard focus on navigation, larger touch targets, reduced-motion support,
  and visible firmware status without exposing inactive OTA controls.
- `compact.css` is the final scoped presentation stylesheet, loaded exactly once
  after the legacy base styles. `dashboard-ui.js` owns navigation, not the palette.
- Shell cache generation `1.0.0-shell39-ui-feedback`; BLE client compatibility remains
  unchanged. No automatic reload, storage migration, or firmware update is added.

## Verification

`node --test tests/*.cjs` runs the dependency-free regressions.

`node tools/ui-smoke.cjs` additionally requires Playwright and its Chromium browser
to be installed and resolvable by Node. It starts a localhost-only server, blocks
external browser requests, and checks 320/390/768/1440px in light and dark mode.
It also uses isolated sample recordings to test local search, playable WAV,
export, grounded local Ask, source tile clicks, delayed hydration, date scope,
cross-day pagination, compact People, search, and person recall. Logo checks
decode real pixels in both themes, with the OS color scheme set to the opposite
of the app preference. Optional `SYNAP_CHROMIUM_PATH` chooses an installed
browser and `SYNAP_UI_OUTPUT` chooses the screenshot directory.

These tests do not replace physical pendant testing: connect/reconnect, tap-start
and tap-stop, triple-tap sleep/wake, live audio, interruption recovery, and OTA
still need a compatible browser and real device before production promotion.
