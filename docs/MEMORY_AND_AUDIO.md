# Reading and working with memory

Today follows the selected local date. Previous/next day, the calendar, date
tiles and Monday–Sunday week navigation share one date-change event. Cloud
navigation coalesces rapid selections to the latest requested day. Older reads
cannot replace a newer selection, and failed reads keep the last successful
content with an error state.

The brief keeps available executive summaries and links each to its source.
Conversation details retain full summaries, participants, decisions, actions
and follow-ups, with pagination rather than a hidden fixed cutoff. Same-day
refresh preserves expanded reading; switching days resets it. Weekly review
shows five recent conversations initially and allows older evidence to expand.
Counts describe data already stored or hydrated in this browser.

## Source identity and editing

Library initially spans all dates. Search covers notes, transcripts, summaries
and names. Source links resolve by recording ID and timestamp; they can restore
cloud-only evidence and show a retryable error if that fails. Local source audio
and notes take precedence over restored metadata. A restored memory does not
claim playable audio when the source is unavailable.

`provenance-links.js` owns the shared Summary/Notes/Transcript viewer. Refreshes
preserve native player nodes, editing drafts and the selected tab. A partial
transcript remains labeled as partial. Naming speakers is documented in
[speaker names](../SPEAKER_NAMES.md); remembering voices and owner voice profiles
are separate operations.

## Merges and actions

Merge combines two to five consecutive source memories. Selection must stay
stable during refresh, errors retain the selection for retry, and responses for
an old day/account cannot insert a card into the current view. Unmerge removes
the derived view while preserving the original IDs, notes, transcripts and
audio. Saved merged memories are snapshots; recreate one after editing sources
if the changed content needs to be included.

[My actions](MY_ACTIONS.md) groups Ask, Next steps, Follow-ups and People. Cloud
operations use canonical IDs and bound their requests. Same-account token refresh
does not discard work; switching accounts invalidates stale responses. Local
keyword recall and unsynced extracted actions retain an explicit local scope.

## Local audio enhancement

Library → Preview clearer audio produces a separate RNNoise Worker preview.
Compare Original/Enhanced and export the enhanced copy. The original audio and
memory are preserved. The preview lasts for the page session and supports up to
20 minutes of mono PCM16 WAV at 16 or 48 kHz, returning 16 kHz mono WAV with delay
compensation.

The model and Worker are cached offline. Short-window speech-preservation checks
fall back to the original if a transformed copy is unsafe. Managed upload
preparation uses the same treatment; see [automatic speech preparation](AUTOMATIC_SPEECH.md)
and [model provenance](../vendor/audio-enhancement/README.md). Enhancement cannot
reconstruct clipped, missing or overlapping speech, and synthetic fixtures do
not establish improved recognition accuracy.

## Presentation and verification

`dashboard-ui.js` owns primary navigation; `compact-layout.js` owns disclosures.
`compact.css` is the final scoped presentation layer after legacy styles.
Palette and Auto/Light/Dark preferences are independent. Auto follows local time
(light 07:00–19:00). Source links reveal the appropriate panel, and mounted
controls retain their state across navigation.

Browser workflows cover merge/retry/unmerge, transcript/source recovery, date and
account races, notes, audio and narrow/light/dark layouts. Run
`npm run test:browser -- workflow transcript actions-functional audio-enhancement`
or the complete suite described in [Contributing](../CONTRIBUTING.md).
