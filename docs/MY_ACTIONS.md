# My actions

Ask Synap, Next steps, Follow-ups and People share one collapsible card. The
primary Actions navigation link opens the card and keeps its selected tab.
Ask is the initial tab. Next steps follows the date chosen in Today and shows
that date above its existing To do, Decisions and Waiting filters.

The tab strip is attached to one shared content area, without nested section
cards or separate pill buttons. Its viewport scales from 220 to 300 pixels,
keeping the card and tabs stationary when switching between short and long
content. Long lists and answers scroll inside that area; each tab retains its
reading position. People uses the shared scroll area instead of a second list
scrollbar, and suggested Ask questions fit on one horizontal row.

`my-actions.js` moves the original four surfaces after `brain-ui.js` creates
them and before `compact-layout.js` registers the shared disclosure. Forms,
lists, IDs and event handlers retain their identities; switching tabs only
changes visibility and ARIA selection. The main observer watches direct child
insertions, so list rendering does not repeatedly rebuild the workspace.

`SynapCompactLayout.reveal(target)` expands My actions and selects the panel
containing the target. Existing `SynapDashboardUI.setView('ask')`, person recall
and `#ask` links still select Ask. The other panel IDs work as deep links too.
Arrow keys, Home and End operate independently in the outer tabs and the
nested Next steps tabs. Settings continues to use the same live header.

The sleep guard subscribes before DOMContentLoaded, since restoring an already
permitted pendant can finish while UI scripts are still loading. A successful
early connection clears the persisted sleep flag without waiting for the UI.

`tools/actions-smoke.cjs` checks the real app at 320, 390 and 1440 pixels in
light and dark mode: draft and filter retention, original node identity, date
changes, keyboard navigation, deep links, disclosure and Settings navigation.
`tools/workflow-smoke.cjs` covers populated People recall, follow-up retries,
source navigation and merge/retry/reload/unmerge. The new script is included
in the offline shell and the browser checks run in CI.

## Data and request boundaries

Cloud Follow-ups supports Open/Done/Dismissed and You/Others filters using
canonical task IDs. Done appears for cloud tasks; locally extracted actions keep
an unsynced label. Canonical People supports search, confirmation, rename and
Prepare. Editing errors retain the draft, and same-account token refresh does
not cancel pending work. Switching accounts invalidates older responses.

Cloud Ask has a 20-second deadline covering authentication and response reading,
Cancel, Retry search and an explicit Search this device fallback. Local recall
is keyword-based. Source failures show a bounded error and Retry source; citations
open the identified recording at the evidence timestamp.

The backend list endpoints return up to 200 people and 200 follow-ups. Prepare
uses up to 12 recent related conversations. Related people may have been
mentioned rather than present. Reminder suggestions are evidence, not scheduled
notifications; calendar export creates an importable file, not a subscription.
New summary fields require new processing or an explicit memory rebuild.

`tools/actions-functional-smoke.cjs` covers populated lists, failed edits, hung
requests, cancellation, stale responses, account changes and source seeking.
It uses the real adapter with simulated API responses and real IndexedDB.
