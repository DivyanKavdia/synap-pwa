# Shared Settings header and navigation

Settings now opens as a non-modal panel below the existing live header. The same header DOM nodes remain mounted, so recording state, Stop/Start, battery details and connection actions keep their original handlers. The panel scrolls independently; the underlying main content becomes inert until Settings closes. A spacer preserves the header's layout when page scrolling is locked.

The Settings button toggles the panel. Back, Escape and Save close it and restore focus and the previous reading position. Primary navigation closes Settings before opening the selected destination. Header geometry follows resizing and the visual viewport. Settings keeps its existing theme, palette, account, firmware and storage controls.

## Consolidated controls

- Ask is reached through the primary Ask tab; the repeated Today shortcut is removed. Person-specific recall still opens the same Ask form with context.
- Search remains in Library; the Memories icon that opened that same search is removed. Merge, selection, source navigation and unmerge remain available in Memories.
- Settings uses the persistent header's connection control and logo. Its duplicate Connect button, wordmark and wordmark observer are removed. Device identity, status and Change remain in the pendant settings card.
- The navigation background follows the selected palette in both light and dark mode.

## Verification

The Settings browser journey checks 320 px, 390 px and 1440 px in light and dark mode: unchanged header nodes and position, unobscured header/nav targets, battery popover, independent scrolling, restored reading position, Save, Escape, navigation and single Ask/search controls. The Bluetooth browser journey stops and saves an active simulated recording from the header while Settings is open. Existing memory journeys still exercise merge, retry, unmerge and Library search. All three browser journeys run in CI.

The Bluetooth reconnect/transport behavior from the previous release is unchanged. Browser checks simulate the pendant; they do not substitute for a physical device test.

Cache generation: `1.0.0-shell48-settings`.
