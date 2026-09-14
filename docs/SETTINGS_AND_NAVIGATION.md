# Shared Settings header and navigation

Settings now opens as a non-modal panel below the existing live header. The same header DOM nodes remain mounted, so recording state, Stop/Start, battery details and connection actions keep their original handlers. The panel scrolls independently; the underlying main content becomes inert until Settings closes. A spacer preserves the header's layout when page scrolling is locked.

The Settings button toggles the panel. Back, Escape and Save close it and restore focus and the previous reading position. Primary navigation closes Settings before opening the selected destination. Header geometry follows resizing and the visual viewport. Settings keeps its existing theme, palette, account, firmware and storage controls.

## Consolidated controls

- Ask is reached through Actions → Ask Synap; the repeated Today shortcut is removed. Person-specific recall still opens the same Ask form with context.
- Search remains in Library; the Memories icon that opened that same search is removed. Merge, selection, source navigation and unmerge remain available in Memories.
- Settings uses the persistent header's connection control and logo. Its duplicate Connect button, wordmark and wordmark observer are removed. Device identity, status and Change remain in the pendant settings card.
- The navigation background follows the selected palette in both light and dark mode.

## Verification

The Settings browser journey checks 320 px, 390 px, 768 px and 1440 px in light and dark mode: unchanged header nodes and position, unobscured header/nav targets, battery popover, independent scrolling, restored reading position, Save, Escape, navigation and single Ask/search controls. The Bluetooth browser journey stops and saves an active simulated recording from the header while Settings is open. Existing memory journeys still exercise merge, retry, unmerge and Library search. All three browser journeys run in CI.

The Bluetooth reconnect/transport behavior from the previous release is unchanged. Browser checks simulate the pendant; they do not substitute for a physical device test.

## Compact layout

Settings aligns with the main workspace and uses a short title/tab header. Device
identity and Change share a row; preference groups use separators, and appearance
choices use compact previews. Introductory slogans and the persistent save footer
are removed.

Save changes appears in the sticky header only when fields saved by the form have
changed. Reverting them hides the action. Switching tabs keeps drafts; closing
without saving restores the opening values. Appearance, provider, reconnect and
notification controls retain their own immediate persistence. A successful form
save updates the baseline before closing. Invalid processing endpoints or cloud
configuration keep the editor open with the draft available for correction.
Keyboard focus and main scroll restore as before.

On wide screens Actions and Library share a row and align at their top edges.
Short action panels use their content height; long lists and answers keep a bounded
scroller. Period tabs remain inside the shared memory card, and source navigation
still opens the original mounted recording nodes.

Cache generation: `1.0.0-shell88-compact-workspace`.
