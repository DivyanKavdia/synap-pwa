# Frontend refresh

Next pass: [Home — light](workspace-home-light.png) ·
[Home — dark](workspace-home-dark.png) · [Daily focus](workspace-focus.png) ·
[Desktop](workspace-desktop.png) · [Library](workspace-library.png).
These previews use isolated fictional recordings, not a connected account.

The daily workspace puts listening totals inside the brief and adds direct
shortcuts to Weekly Review, People and Follow-ups. To do, Decisions and Waiting
share one compact panel with counts. Its tabs support arrows, Home and End, and
retain selection during background updates. Core app sections stay mounted.

Conversation cards show the actual local start time, a summary and explicit
participants. People who are only mentioned are not presented as attendees.
The older card decorator yields to the current renderer. Processing status sits
outside the brief in an expandable row; retry status stays visible when collapsed.
Opening it preserves the full processing steps and cost breakdown.

Library searches saved names, notes, transcript text and structured conversation
context without a network request. Search combines with the date filter and
paginates matching recordings. Source navigation clears a search that would hide
the requested recording, preserves its ID/offset, and reveals its page. Cards
include their date and a summary preview, and use two columns on desktop.

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
- Weekly Review opens with five newest conversations, including Today labels,
  and offers Show more for all older evidence. Same-day refreshes retain the open
  review. Read epochs prevent stale IndexedDB results from erasing fresh memory;
  processing/save events refresh it in place. Incomplete cloud weeks remain
  retryable with a visible Refresh action. Source links refresh Library before
  opening newly processed recordings. Only real conversation details are counted.
- Keyboard focus on navigation, larger touch targets, reduced-motion support,
  and visible firmware status without exposing inactive OTA controls.
- `compact.css` is the final scoped presentation stylesheet, loaded exactly once
  after the legacy base styles. `dashboard-ui.js` owns navigation, not the palette.
- Shell cache generation `1.0.0-shell41-workspace`; BLE client compatibility remains
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

Weekly tests also cover 37 conversations, processing completion without reload,
UTC/local-midnight boundaries, incomplete cloud hydration and week-switch races.
Browser fixtures use Asia/Kolkata; run `TZ=Asia/Kolkata node --test
tests/weekly-review.cjs` for timezone-specific unit verification.

Workspace browser checks cover keyboard tab selection, focused shortcut
navigation, processing disclosures, search/empty results, combined date/search
filters, pagination, and source navigation while search is active. The browser
clock runs from a fixed midday start so "today" cannot change during a test run.

These tests do not replace physical pendant testing: connect/reconnect, tap-start
and tap-stop, triple-tap sleep/wake, live audio, interruption recovery, and OTA
still need a compatible browser and real device before production promotion.
