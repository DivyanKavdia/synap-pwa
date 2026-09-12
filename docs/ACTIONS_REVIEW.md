# Actions functionality review — 12 September 2026

Release: `1.0.0-shell67-actions`. Reviewed against the app UI, `docs/MEETING_FEATURES.md`, and the People, Follow-ups, Ask and preparation backend routes. The starting production revision was `a60db4cbd548608bcc052985442a76229c5f6c55`.

## Intended behavior versus findings

| Area | Intended behavior | Finding and repair | Verification |
| --- | --- | --- | --- |
| People → Prepare | Show related conversations, open cloud actions and supporting source times. | Results were appended below the whole People list inside a short scroll area. Prepare now inserts its result before the list, reveals and focuses its heading, and returns focus on Close. Local preparation now includes older and legacy memories and labels mentioned actions as potentially completed. Cloud failures retain saved evidence alongside Retry. | Populated mobile People list; heading is inside the actual viewport without a second scroll; older local person; cloud preparation; Close, timeout, retry and switching people/accounts. |
| Next steps | Show decisions, commitments and waiting items for the selected date, with source links. | Only six items per list were rendered despite larger counts. All derived items now remain accessible through the shared scroll area. This view is evidence from the selected day, not a separate task-completion database. | Nine commitments, final item opens the correct recording at 9 seconds; nested tab and date selection tests. |
| Follow-ups | Show open cloud tasks, filter Mine / Waiting / All, and persist Done. | Only 30 rows were accessible. Local fallback ignored older dates. A stalled People request delayed this list. Now every returned row renders, local fallback spans saved dates, lists load/retry independently, and the scope is explicit. Done remains retryable, prevents duplicate submissions, and cannot be undone by a list request that started before completion. | 34 rows; 17 Mine and 17 Waiting; retry while People remains stalled; failed Done retry; stale list response after completion. |
| People browse and edit | Browse/search people, recall their conversations, confirm or correct names. | Older local people were omitted. Background decoration and failed saves discarded edits. On a 320px screen the name editor and Save were clipped outside the viewport. Edits now stay in the scroll flow, retain typed text on failure, and update the associated Prepare label/name. Canonical IDs disambiguate controls even when names match. | Search an older person; failed rename retains text; touch Save succeeds; renamed Prepare uses the current name; People recall remains source-linked. |
| Ask Synap | Signed-in grounded recall with citations; local recall when signed out. | An unbounded cloud request could keep the form disabled. Searches now have a 20-second deadline covering authentication and response reading, Cancel, Retry search, and an explicit Search this device fallback. Superseded or different-account replies cannot replace the current answer. | Hanging request releases form; retry succeeds; cancellation discards late results; local fallback is labeled; cited audio seeks to 7 seconds. |
| Source links | Open the cited recording and align transcript/audio with the evidence time. | A failed cloud-only source restore silently did nothing. It now shows loading, a bounded failure and Retry source. | Missing cloud-only source → error → retry → real IndexedDB restore and visible transcript; existing local timestamp/audio tests. |
| Actions navigation | Four stable tabs with retained draft, filters, reading position and keyboard navigation. | Existing behavior verified. The fixes preserve mounted panels and the shared scroller. | Light/dark layouts at 320, 390 and 1440px; keyboard tabs, deep links, settings return, drafts and scroll position. |

Authentication refresh is distinct from an account change: rotating a token for the same person must not cancel preparation or invalidate an in-flight completion/save. Account changes still invalidate prior responses.

## Product limits and dependencies

- Grounded semantic Ask, canonical people, current task completion and cloud preparation require a working signed-in backend. Local recall is a keyword search over memories saved in this browser.
- Local extracted actions do not prove that a task is still open. They are shown with an explicit unsynced scope; Done is available for cloud follow-ups with canonical IDs.
- The current backend list endpoints return up to 200 people and 200 follow-ups. This repair removes the extra client limits of six/30; it does not introduce backend pagination. Prepare deliberately shows up to 12 recent related conversations. Related people can have been mentioned rather than present.
- Reminder suggestions are extracted evidence, not scheduled notifications. Calendar export creates a file for the user to import; it does not create a live calendar subscription or send reminders by itself.
- Preparation cannot invent information absent from saved/processed memories. Newly introduced chapters and reminder fields require new processing or an explicit memory rebuild.

## Validation and practical boundary

`tools/actions-functional-smoke.cjs` uses the production app shell, real IndexedDB and the real `SynapBackend` adapter. It simulates authenticated API responses, outages, hung requests and stale replies and uses mobile touch actions. It is included in the production CI workflow.

Regression coverage includes `tools/actions-smoke.cjs`, `tools/meeting-features-smoke.cjs`, `tools/workflow-smoke.cjs`, and the dependency-free unit suite (`node --test tests/*.cjs`). The same CI workflow also checks transcript recovery, controls, connection/recovery, firmware progress, settings, speaker names and audio enhancement.

Browser fixtures verify client behavior and API contracts. They do not establish that a particular private production account has processed memories, that its backend credentials are healthy, or that a physical pendant/Bluefy radio session succeeds. Speech recognition accuracy and real-device recording/firmware transfer require device testing.
