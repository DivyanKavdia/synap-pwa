# Memory workspace

Today and Weekly review are two tabs in one card. Today contains the selected
day's brief, optional conversation detail, and existing memory cards with their
summary, transcript, notes and merge controls. Weekly review groups source-linked
conversations, decisions and commitments by day. Its week arrows and This week
shortcut use the same selected date as the day calendar. Week navigation, This
week and Refresh share one row, with 44px touch targets. This week stays visible
and is disabled when the current week is selected. The date range may wrap
inside its label on narrow screens; the controls remain on one row.

`index.html` owns the two tab panels. `memory-workspace.js` selects them and
handles Arrow keys, Home and End. Source cards stay mounted, retaining open
cards, edits and event handlers. `productivity-tools.js` renders the week directly
inside its panel; `app.js` retains ownership of daily memory cards. Empty days
use the existing compact summary without an additional empty Memories card.

The bottom Today and Weekly links explicitly select their corresponding panel
before scrolling to this shared card. Switching the tabs inside the card also
updates the bottom highlight through `synap-memory-period-changed`. Scroll and
resize updates use the selected period, including at the top of the page.
`#memoryWeekPanel` and the older `#synapWeeklyReview` link open Weekly;
`#insights` still opens the memories inside Today. The appearance bootstrap
leaves URL fragments for the dashboard to handle.
`SynapCompactLayout.reveal(target)` selects the containing period before opening
any conversation disclosure. Weekly review itself no longer needs a second
expand/collapse control. Library remains the home for original recordings.

The date picker remains the single day-change event for brief, memory, cloud
history and Library consumers. Actions has its own timeline relative to the
current date; browsing older memories does not hide tasks due now. See
[My actions](MY_ACTIONS.md) for state and date rules.

Browser coverage includes day/week keyboard navigation, week/date changes,
source playback, memory-node identity, light/dark mobile layouts, and existing
merge and transcript workflows. The workspace controllers are cached in the offline shell. Shell revisions advance without changing BLE compatibility.

Library keeps search and date/status filters in one control group. The Day
filter follows the selected date, shown below the controls. Selection actions
keep the existing mounted recording cards and cross-page selection rules; the
Select all checkbox describes that scope to assistive technology.

Header controls share `--header-control-radius` in `compact.css` and a 44px
height. `touch-event-bridge.js` owns the battery markup, with the percentage
inside its outline; both telemetry versions use a proportional fill. Battery
details and disconnected/unavailable states retain their existing behavior.
