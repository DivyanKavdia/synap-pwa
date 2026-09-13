# Memory workspace

Today and Weekly review are two tabs in one card. Today contains the selected
day's brief, optional conversation detail, and existing memory cards with their
summary, transcript, notes and merge controls. Weekly review groups source-linked
conversations, decisions and commitments by day. Its week arrows and This week
shortcut use the same selected date as the day calendar.

`index.html` owns the two tab panels. `memory-workspace.js` selects them and
handles Arrow keys, Home and End. Source cards stay mounted, retaining open
cards, edits and event handlers. `productivity-tools.js` renders the week directly
inside its panel; `app.js` retains ownership of daily memory cards. Empty days
use the existing compact summary without an additional empty Memories card.

The primary Today and Memories links are shortcuts into this shared card.
`SynapCompactLayout.reveal(target)` selects the containing period before opening
any conversation disclosure. Weekly review itself no longer needs a second
expand/collapse control. Library remains the home for original recordings.

The date picker remains the single day-change event for brief, memory, cloud
history and Library consumers. Actions has its own timeline relative to the
current date; browsing older memories does not hide tasks due now. See
[My actions](MY_ACTIONS.md) for state and date rules.

Browser coverage includes day/week keyboard navigation, week/date changes,
source playback, memory-node identity, light/dark mobile layouts, and existing
merge and transcript workflows. The two new controller files are cached in the
offline shell. Shell revisions advance without changing BLE compatibility.
