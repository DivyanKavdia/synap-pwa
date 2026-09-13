# My actions

Ask Synap, Next steps, Follow-ups and People share one collapsible card. The
primary Actions navigation link opens the card and keeps its selected tab.
Ask is the initial tab. Next steps and Follow-ups share Timeline and Status
dropdowns. The timeline is relative to the current local date, independent of
the day being browsed in Memories. The existing To do, Decisions and Waiting
filters remain inside Next steps.

The tab strip is attached to one shared content area, without nested section
cards or separate pill buttons. Its viewport scales from 220 to 300 pixels,
keeping long content inside the card. Timeline controls appear above the
scroller for Next steps and Follow-ups. Long lists and answers scroll inside that area; each tab retains its
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

Actions supports Open, Completed and All statuses. Complete and Reopen work in
both Next steps and Follow-ups, using the same task state. Dismissed cloud tasks
are available under All statuses and can be reopened. Cloud tasks are fetched
with `state=all` and saved by canonical ID; unsynced and direct-provider local
tasks remain visible alongside them. Cloud state owns synced sources; a response started before a mutation
cannot undo it. Local completion is written atomically to
`recording.actionStates[accountScope][sourceKey]`, preserving the audio and other
metadata. Local completion stays on this device and does not claim cloud sync.
`interaction-surfaces.js` owns task lists; `brain-ui.js` keeps the day summary
and pure extraction helpers. `action-state.js` owns date and identity rules.

Timeline options are All time (default), Last week, Today, This week, Next week,
Next 30 days, Overdue and No due date. Weeks run Monday through Sunday in local
time. Next 30 days includes today and the following 29 days. Tasks use their
due date; undated tasks use their recording date for historical/current ranges.
Undated tasks never appear as overdue or due in a future period. Decisions are
facts, so only the timeline applies to them, using their recording date. Older
cloud tasks with no locally available source and no recorded timestamp remain
available in All time and No due date.

People supports search, Prepare, and deletion. Cloud profiles additionally
support confirmation and rename. The management menu asks for confirmation
before deletion. `DELETE /v1/people/:personId` removes only the authenticated
account's profile; recordings, transcripts and extracted evidence remain intact.
Local profiles are hidden by name and latest mention time in an account-scoped
browser preference. A new conversation may rediscover a removed name. Cloud
deletions suppress stale list responses for the active session. Editing errors
retain the draft, and same-account token refresh does not cancel pending work.
Switching accounts invalidates older responses.

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
`tools/memory-workspace-smoke.cjs` checks period tabs, timeline boundaries, local
completion after reload, and local People deletion without losing recordings.
