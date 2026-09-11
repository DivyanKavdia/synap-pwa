# Memory workflow repair

The preceding cleanup passed source-level checks and general UI tests, but those checks did not complete a merge. They were insufficient evidence that all visible workflows worked.

## Reproduced failures

- **Merge:** the action was outside the collapsed Memories body. Clicking it created a hidden selection toolbar. Once selection started, the memory module observed its own subtree writes and repeatedly removed/recreated its checkboxes. A browser probe measured 1,376 child-list mutations in 500 ms; a normal checkbox click timed out.
- **Errors:** merge errors were immediately replaced by ordinary selection instructions in `finally`. Unmerge and follow-up failures were only logged to the console.
- **Duplicate memory views:** memory-tools and provenance-links both created summary/transcript tabs. Provenance refresh replaced its own view even when nothing changed, resetting the selected tab. Timestamp-first matching could bind an imported card to another recording with the same timestamp.
- **Local People recall:** tapping a person opened Ask with a query but did not execute local recall.
- **Duplicate search:** a separate Memories search scanned the same recordings as Library search and used an independent, timed navigation path.

## Changes

Core rendering announces a completed source-card reconciliation. Merge listens to that event instead of observing its own DOM. Checkboxes retain their nodes and selections; the action reveals its tile. Merge/unmerge consume confirmed API responses directly, preserve source records, retain errors for retry, and discard responses for a day/account the user has left. The two-to-five and consecutive-source rules are preserved.

Provenance now owns one summary/notes/transcript viewer. It binds by recording ID and skips unchanged views. Merged cards use that viewer and provide individual source links. Original card expansion and selected tabs survive background refresh.

The Memories search icon opens the existing Library search, including notes, transcripts, summaries and names across all dates. The duplicate search renderer, database reader and navigation code are removed. People recall submits local queries, and follow-up failures remain visible and retryable. Canonical People/follow-up caches are cleared when the active account changes.

## Validation

`tools/workflow-smoke.cjs` loads the production shell, real IndexedDB and generated WAV recordings. It uses a deterministic cloud API fixture with injected errors/delays. Its journeys cover:

- Opening Merge from a collapsed tile; stable checkboxes; invalid adjacency; five-source limit.
- Failed merge with retained selection; retry; chronological source IDs; one merged view.
- Background refresh and page reload; transcript tabs; individual source navigation.
- Failed unmerge and retry; unchanged recording IDs, titles, notes, transcripts, summaries and WAV sizes.
- Single memory viewer and persistent Notes tab; unified search and opening its result.
- Local People search/recall and source navigation; follow-up failure, retry and completion.
- Changing day while a merge is in flight, without inserting the old response in the new day.
- Layout and interactions at 320 px light, 390 px dark and 1440 px light.

The complete workflow runs in GitHub CI on pull requests and main. The existing general browser suite also passes across light/dark at 320/390/768/1440 px, including day/week reading, themes, playback and WAV export. All 195 PWA checks pass.

These results verify browser behavior and the existing API contract. They do not verify Google sign-in, a merge against the user's production account, physical Bluetooth reliability or OTA. Firmware and backend logic are unchanged by this repair.

Installed app cache generation: `1.0.0-shell45-memory-workflows`.
