# Making Synap useful after a conversation

Product proposal · 17 September 2026

Reviewed against commit `65c30b66d48536f03e6d47ec0fb2046151ab4971`.
This document proposes behavior and an implementation sequence. It does not
describe a new production release or measured model accuracy.

## The job to do

After opening Synap, a person should quickly understand:

1. What changed or was established?
2. What have I actually committed to?
3. What am I waiting for, and from whom?
4. What decision, missing owner, or unanswered question is preventing progress?
5. What useful step can I take now, and what evidence supports it?

A useful insight combines an observation, its supported consequence, and an
available action. Sometimes the honest result is simply a memory worth keeping:
a family story, an explanation, or a personal reflection needs no task list.

The product should measure whether it helps people close real commitments and
recover context. More extracted tasks, longer summaries, and more notifications
are not success measures.

## What the current implementation already does well

- Extraction distinguishes outcomes, decisions, commitments, explicit reminder
  requests, questions, facts, and risks. It includes source offsets and quote
  validation for several categories.
- Meeting details already expose much of that structure. Copy recap, source
  navigation, calendar-file export, and People → Prepare already exist.
- Actions and Follow-ups share completion state. Cloud publication is atomic
  for an ordinary recording, and retries preserve unchanged task identities.
- Daily aggregation avoids another model call for every completed recording.
- Explicit names take precedence over voice estimates; uncertainty can remain
  anonymous. That principle must also apply to task ownership.

These are foundations to improve, rather than features to duplicate.

## Where meaning is currently lost

| Observed behavior | Effect on the user | Relevant implementation |
| --- | --- | --- |
| Next steps and Follow-ups render the same underlying personal/waiting lists, mostly sorted by due date and recency. | Two destinations do not offer sufficiently different answers to “What should I do now?” and “What is still open?” | [interaction-surfaces.js](../interaction-surfaces.js), `filteredActions`, `renderFollowups` |
| Indexed task content retains task, owner, and kind, but drops the extraction's quote and end offset. It does not retain a structured dependency or completion condition. | A task may be correct but too vague to act on without reopening the recording. | [index-memory.ts](../backend/src/pipeline/index-memory.ts), task projection; [brain.ts](../backend/src/http/routes/brain.ts), follow-up API |
| Cloud owner type is only self/other; an empty owner becomes other. Local unowned actions can become mine. | “Someone should check this” can appear as either your responsibility or something another person owes you. | [types.ts](../backend/src/store/types.ts), `FollowUpDoc`; [brain-ui.js](../brain-ui.js), `derive`; [interaction-surfaces.js](../interaction-surfaces.js), `followEntries` |
| The day UI joins recording summaries. Its conversation digest omits outcome/fact/risk fields that are available in Meeting details. | The main recap hides some of the most useful information and repeats topics instead of showing what changed. | [brain-ui.js](../brain-ui.js), `renderBrief`, `conversationModel`, `digestMarkup`; [meeting-tools.js](../meeting-tools.js) |
| The backend daily brief reads extracted memories, not current task state; it omits follow-ups and stores questions as strings without source references. | An historical commitment can look current after completion, and an unanswered question loses its direct evidence link. | [brief.ts](../backend/src/pipeline/brief.ts), `fallbackBrief` |
| Weekly review counts conversations, decisions, commitments, and topics. | Activity counts do not explain progress, unresolved dependencies, or what deserves attention next week. | [productivity-tools.js](../productivity-tools.js), `buildWeekSummary` |
| Speaker corrections and memory-only rebuilding update memory while deliberately preserving existing task indexes. Task matching includes mutable text, owner, date, and offsets. | Correcting a summary can leave a different owner or task in Actions; simply reindexing would risk losing prior completion and manual date changes. | [speaker-names.ts](../backend/src/http/routes/speaker-names.ts), [process.ts](../backend/src/pipeline/process.ts), [index-memory.ts](../backend/src/pipeline/index-memory.ts) |
| Quote validation checks whether text occurs somewhere in the transcript. Date validation checks calendar validity. | Those checks cannot establish that the quote supports the claim, identifies the owner, states the deadline, or remains valid after a later correction. | [memory.ts](../backend/src/gemini/memory.ts), `validateMemory` |

A local synthetic counterexample confirmed the last gap: the validator retained
“Budget approved” with the real quote “The budget has not been approved,” and
retained a cancelled commitment with an unstated but valid 2030 due date. The
same fixture confirmed that the brief omitted its unassigned follow-up and
reduced its question to a string. This tests validator limitations; it is not a
claim that Gemini produced those responses or that a user's recording was wrong.

## One model, with clear distinctions

Keep factual extraction, personal workflow, and optional advice separate.

| Item | Meaning | Appropriate user control |
| --- | --- | --- |
| Outcome | Something actually happened or was completed. | Open evidence; correct it. |
| Decision | An option was explicitly settled. | See reason and constraints when stated; track later changes. |
| My commitment | I explicitly agreed to do something. | Complete, edit, defer, or dismiss. |
| Waiting on | A specific person explicitly committed to deliver something. | See promised date; choose when to check; draft a follow-up. |
| Needs clarification | A useful unresolved matter lacks an owner, a decision, or enough context. | Assign to myself, correct an owner, clarify, or dismiss. |
| Suggested next step | Synap proposes something potentially useful from available evidence. | Accept, edit, or dismiss before it becomes a personal task. |

An observed commitment may enter the open list automatically if its evidence and
ownership meet the extraction checks; it should still say it was extracted.
“User confirmed” is reserved for a real confirmation. Model confidence alone
must never imply user approval. Advice must never masquerade as a recorded promise.

“Priya was mentioned” does not establish “Priya owes me this.” Unknown ownership
stays unknown. A conditional commitment can be valid but blocked, rather than
ready to execute. Proposed dates remain proposals until agreed or set by the user.

## The user experience

### Immediately after processing

Show a short outcome recap, proportional to the recording:

- **What changed:** the actual result or final decision, in one or two sentences.
- **What matters:** specific constraints, numbers, reasons, or an unresolved
  blocker, only when supported.
- **Next:** the user's real commitments, known dependencies, and material
  questions needing clarification.

An expansion exposes the complete chronological summary and evidence. Empty
categories stay absent. A short note should not become a multi-section report.
The last correction in a conversation must override an earlier proposal.

For long recordings, retain conversation and topic boundaries internally, but
deduplicate the recap so it does not repeat the same decision under every chapter.
Use the person's preferred recap language, preserving original-language quotes
and exact confirmed names.

### Next steps: help me choose

Make this a small focus view with up to three currently useful items, plus
“View all.” It should not fill three slots merely because they exist.

Use transparent rules before introducing learned ranking:

1. User-pinned items, then accepted commitments due or overdue in the user's timezone.
2. An actionable dependency that explicitly blocks a dated commitment.
3. A newly changed commitment or material unresolved decision.
4. Undated items the user has chosen to review; optionally suggest reviewing an
   old item without declaring it urgent.

Show a short reason such as “Due today,” “You pinned this,” or “Needed before
sending the proposal.” Do not invent importance, urgency, effort, or downstream
impact. When a commitment is blocked, surface the dependency and offer a useful
control; do not present the blocked deliverable as executable now.

Users can pin and defer. Selection should reflect their preferences over time
without treating every dismissal as disinterest in the entire person or topic.

### Follow-ups: keep track of unfinished matters

Use this as the complete, durable view: **Mine**, **Waiting on**, and **Needs
clarification**, with existing date/status controls and completed history.
It is the same underlying item whether reached through a recording, Next steps,
People, a daily brief, or a weekly review.

Useful controls depend on the item:

- Mine: Complete, Edit, Review later, Dismiss, Source.
- Waiting on: Mark received, Choose check-in date, Draft follow-up, Source.
- Needs clarification: I'll take this, Set/correct owner, Resolve question, Dismiss.
- Suggested step: Accept, Edit, Dismiss, Why suggested.

Keep three times distinct: the **promised deadline**, the user's **check-in
date**, and any explicitly configured **notification time**. Choosing to check
tomorrow must not rewrite the other person's promise. A date-only promise is not
overdue at the start of that same day. Processing time never sets a deadline.

Every card should answer:

| Field | Rule |
| --- | --- |
| Task or question | Specific verb/object/context; resolve “send it” only where the referent is established. |
| Owner and recipient | Known and evidenced, otherwise explicitly unassigned. Being mentioned is insufficient. |
| Date and condition | Exact stated date/condition, a visible user edit, or “No date agreed.” |
| Why it is shown now | A factual ranking reason or a clearly labelled suggestion. |
| What completion means | A stated deliverable/result where available; otherwise leave it unspecified. |
| Evidence | Short supporting quote and source link, with approximate timing marked when only segment timing exists. |

### Daily and weekly views: show progress and changes

The daily recap answers “What changed today?” and links to current actions.
Historical facts remain historical: “You agreed to send the proposal on Monday”
can stay in Monday's recap after the task is completed. The linked task must show
its current completed state and must not re-enter today's queue.

The weekly review should show completed work, decisions that changed, still-open
commitments, dependencies blocking progress, and items the user may want to carry
forward. Recording counts are secondary context. An offline device or a partial
processing backlog must show its coverage instead of implying that it knows the
whole week.

### Before the next conversation

Build on existing People → Prepare. Show the last established decision, current
commitments in both directions, unresolved questions, and any relevant changes
since the last conversation. Offer a compact agenda to copy or edit.

Scope matters: a person mentioned in a discussion is not necessarily a
participant, and every task in a meeting containing their name is not
necessarily owed to or by them. Preparation should distinguish directly related
items from broader context.

## Worked example

Illustrative only; not taken from a user's recording. Capture: Thursday,
17 September 2026. Speaker identities are confirmed.

> You: We agreed the budget ceiling is ₹2 lakh. I'll send the revised proposal
> after Priya confirms the supplier costs.
>
> Priya: I'll confirm those costs by Friday.
>
> You: We still need to decide the launch date.

| Surface | Useful result |
| --- | --- |
| Recap | Budget capped at ₹2 lakh. The revised proposal depends on supplier costs. The launch date remains undecided. |
| My commitment | Send the revised proposal. Waiting for costs. No date agreed for sending. |
| Waiting on | Priya to confirm supplier costs by Friday, 18 September. |
| Needs clarification | Decide the launch date. Decision owner not established. |
| Optional suggestion | Set a check-in for the supplier costs. User chooses whether and when. |

Do not make the proposal due Friday: that deadline belongs to Priya's costs.
Do not assign the launch decision to the wearer because they raised the question.

If a later recording says “Priya sent the costs,” link a proposed update to the
existing dependency with its evidence. In the first release, let the user confirm
closure and unblock the proposal. Do not silently resolve a similarly named item
from a different project. If the user already marked it received, retain that
choice and attach the new evidence without creating a duplicate.

## Continuity across recordings

An item's identity should survive paraphrasing, corrected names, edited dates,
and summary rebuilding. New recordings can supply new evidence or propose a
change to an existing item; they should not automatically create another task.

Store an immutable item ID, append source references, and preserve user edits
separately from extracted claims. Match candidates using confirmed people,
specific subject/deliverable, recording context, and dates. Semantic similarity
can find candidates; it cannot prove identity. Ambiguous merges and conflicting
updates require review.

Cancellation, supersession, reported completion, and user-confirmed completion
are different events. A newer unsupported claim should not win merely because
it arrived later. Every proposed correction should point to the source that
justifies the change. User completion/dismissal must survive all automatic rebuilds.

Later insights can connect reliable observations, for example: “The launch date
remains unresolved in three related conversations.” Each counted conversation
must be distinct and relevant. Say “No newer update in available memories,” not
“Priya has not done it”; Synap cannot observe everything that happens outside
recordings.

## Implementation shape

1. **Preserve extraction evidence.** Extend encrypted task payloads with quote,
   end offset, source revision, and supported context. Add quote references for
   follow-ups and questions. Validate quote/span alignment, owner attribution,
   date language, conditions, and later corrections. A matching string is only
   one check, not proof of semantic support.
2. **Separate source claims from workflow.** Add explicit unknown ownership and
   review provenance. Keep user overrides, completion, dismissal, pinning, and
   deferral separate from model output. Record the provenance of each due date.
   Store task text, names, reasons, and quotes inside encrypted content; avoid
   exposing them in logs or new plaintext indexes.
3. **Use one current projection.** Derive action cards, preparation, actionable
   brief sections, and exports from canonical item state. Recording recaps remain
   faithful historical snapshots linked to that state. Version projections so
   clients cannot present a new summary with an obsolete action owner unnoticed.
4. **Reconcile corrections safely.** Replace mutable-content task identity with
   stable IDs and versioned source associations. Migrate existing IDs and retain
   completion/dismissal/manual dates. Only then let speaker edits and memory-only
   rebuilds update the corresponding action projection. Do not solve stale
   ownership by deleting and recreating every task.
5. **Add bounded continuity.** Look up a small relevant set of open items for
   reconciliation. Use deterministic assembly for focus lists and briefs. Reserve
   model work for extraction and ambiguous, consequential interpretation; do not
   resend audio or the full lifetime history for every change. Advice can be
   generated on demand from the selected evidence.

Introduce fields additively and retain legacy readers. Older items without a
quote may show a recording link and “Evidence detail unavailable”; do not
manufacture a quote. Backfill from stored structured memory when attribution is
unambiguous, otherwise offer an explicit rebuild from the retained transcript.
Audio playback depends on whether the audio is still available.

Keep same-account isolation, cancellation, offline state, stale-response guards,
and atomic publication. A global list truncated at 200 tasks cannot truthfully
drive an all-time focus view: add pagination or purpose-specific queries with
explicit coverage. Add and validate indexes through the existing infrastructure
process. The previously observed Firestore deployment permission blocker must
be resolved before backend changes can be called live.

## Build order

| Release | Scope | User benefit / acceptance condition |
| --- | --- | --- |
| 1: trustworthy actions | Preserve evidence; separate unassigned items; preserve user state during corrections; show specific tasks and supported conditions. | Every surfaced commitment has an identifiable source; correcting a name or rebuilding a summary does not resurrect completed tasks or leave an obsolete owner in Actions. |
| 2: useful focus and recap | Differentiate Next steps from the full Follow-ups list; up to three explained focus items; concise outcome recap; current task state in all views. | A person can see what changed and choose a useful next step without rereading the transcript. No fabricated deadlines or padded tasks. |
| 3: continuity | Stable links across recordings; review proposed cancellations/completions/changed dates; prepare an agenda; weekly progress and carry-forward. | Repeated discussion does not multiply tasks, and later evidence can close or update an existing matter with a visible history. |
| 4: optional assistance | On-demand next-step suggestions and editable follow-up drafts; explicitly configured reminders where supported. | Suggestions are recognisable as suggestions; the user controls acceptance and external delivery. |

No automatic messages to other people. Drafting, exporting, scheduling a
notification, and actually sending are distinct actions with distinct user intent.
Notification support must be verified for the target iPhone/Bluefy environment
before promising background reminders. An in-app check-in date is useful even
without notification delivery.

## Quality bar and evaluation

Use an adjudicated transcript set covering work discussions, personal notes,
family conversations, English, Hindi/Hinglish, anonymous speakers, overlapping
audio, negation, suggestions versus promises, relative dates, corrections,
cancellations, conditional tasks, and repeated discussions across days. Include
recordings that legitimately contain no action.

Separate evaluation layers:

- Transcript accuracy and speaker identity: can we recover the necessary words
  and attribute them appropriately?
- Extraction: is each claim supported, correctly classified, correctly owned,
  correctly dated, and still valid after later statements?
- Reconciliation: does an update attach to the right existing item, retaining
  all human edits and state?
- User experience: does the person understand why the item matters and know
  what to do with it?

Critical regression cases should include:

| Example | Required behavior |
| --- | --- |
| “We could ship Friday.” | Proposal, not a settled decision or Friday deadline. |
| “Someone should check the invoice.” | Needs clarification; not assigned to you or an invented counterparty. |
| “I will send it. Actually, don't send it.” | No surviving unconditional send commitment. |
| “Budget has not been approved.” | Cannot support an approved-budget outcome, even with an exact quote. |
| “I'll send it after Priya confirms costs Friday.” | Preserve the dependency and deadline attribution; clarify ambiguous wording instead of assigning Friday to both items. |
| A task was marked done, then its speaker name is corrected. | Same task remains done; owner/display information updates coherently. |
| A second recording paraphrases a prior promise. | Candidate update to the existing item; ambiguous matches are reviewed. |
| Only two of five recordings finished processing. | State partial coverage; no claim that the entire day is resolved. |

Track task acceptance without correction, wrong-owner/wrong-date corrections,
unsupported commitment rate, duplicates, completed items resurfacing, evidence
link accuracy, and time from opening Synap to choosing a useful next step. Include
recall of real commitments so an empty list cannot game precision. Track processing
latency and model cost alongside quality. Set quantitative release targets from
the baseline and reviewed examples, not from an invented confidence percentage.

Give concise feedback controls: Wrong owner, Not a commitment, Wrong date,
Duplicate, Already done. Corrections should immediately update all views, and
preference learning should stay scoped to the account. Real model evaluation and
user trials are needed: passing schema tests and mocked UI tests alone cannot
establish that summaries or insights are meaningful.
