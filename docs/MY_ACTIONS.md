# My actions

Ask Synap, Next steps, Follow-ups and People share one collapsible card. The
primary Actions navigation link opens the card and keeps its selected tab.
Ask is the initial tab. Next steps follows the date chosen in Today and shows
that date above its existing To do, Decisions and Waiting filters.

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
