# Synap workspace — September 2026

The product has four destinations: Brief, Memories, Actions, and Ask. Each stays
mounted when hidden, so navigating does not recreate a recorder, discard a draft,
reset an expanded source, or interrupt the storage journal. Weekly review lives
inside Brief. The persistent header owns connection, battery, recording, camera
and settings on every screen.

## Research and decisions

We reviewed the products' own documentation:

- [Plaud: Ask across files](https://support.plaud.ai/hc/en-us/articles/51041335681689-Ask-Across-All-Files-Ask-Plaud) and [single-file questions](https://support.plaud.ai/hc/en-us/articles/50636602977817-Ask-Based-on-a-Single-File-Ask-Plaud): contextual questions and inspectable sources make recall useful.
- [Omi: conversations, memories and chats](https://help.omi.me/en/articles/13153612-conversations-memories-and-chats): connect transcripts, useful facts and tasks; make history searchable and editable.
- [NeoSapien](https://neosapien.ai/): bring conversation outcomes into daily/weekly planning and follow-through.

Synap applies these interaction patterns in its own design. It retains original
audio and existing device support. No competitor assets or account data are used.

## What changed

**Brief.** A compact activity strip, readable recap, three next priorities, source-
linked decisions/risks/open questions, and a conversation list with previews.
Focus uses the canonical action snapshot independently of the Actions filters,
so filtering tasks to next month cannot hide today's priorities. It updates when
an action is completed or edited. The recap is an excerpt of existing summaries;
Read more reveals the full summaries and sources. It does not synthesize new facts.

**Memories.** Search across saved conversations, people, notes and tasks. Rows show
meaningful titles, summary excerpts, participants, decisions, action counts and
processing status. Existing media filters, favourites, pagination, selections,
imports, retries, deletion and source playback remain available. A topic shortcut
opens Ask with the memory title as an explicit query; it does not claim single-file
retrieval.

**Actions.** Start with Next steps. Overdue, due-this-week and undated counts open
matching filters. Deadline badges distinguish overdue/today/upcoming, user-set
and unspecified dates. Completion and edits preserve the existing durable local
and cloud behavior. Follow-ups, clarification, decisions, waiting and People
remain accessible, with normal page scrolling instead of an inner scroll trap.

**Ask.** A dedicated destination with an editable multiline question, all/day/week
scope, four task-oriented prompts, source excerpts/timestamps, answer copying,
and recent questions. Scope is sent to the existing authenticated retrieval route
and also applied to local recall. Questions are limited to 1,000 characters. Enter
submits; Shift+Enter adds a line. Recent questions live only in memory and are
cleared on account change or Clear session. Reusing one uses the visible current
scope. Search cancellation, timeouts, account fences and local fallback remain.

## Presentation ownership

`dashboard-ui.js` owns destination visibility, keyboard focus and reading position.
`my-actions.js` owns only the three Actions subpanels. `memory-workspace.js` owns
day/week selection. `compact-layout.js` now owns the conversation disclosure only.
No new document observer or prototype patch is introduced.

`workspace.css` is the final stylesheet for the workspace, navigation and source
rows. Existing styles continue to own device and Settings details. It uses theme
accents, neutral readable surfaces, a desktop side navigation, a phone bottom
navigation, safe-area padding, and semantic hidden states. Offline cache, script
versions and all shell revision constants advance together.

## Verification

`tools/workspace-experience-smoke.cjs` uses the real page and IndexedDB, with
isolated fixture data and blocked external requests. It checks populated mobile,
tablet and desktop layouts; one visible destination; canonical node identity;
completion and priority refresh; exact source routing; scoped local Ask and
session clearing. Existing browser journeys cover cloud account changes, stalled
requests, editing, playback, selection, Settings, capture and recovery. Browser
fixtures do not establish physical Bluetooth endurance or speech accuracy.
