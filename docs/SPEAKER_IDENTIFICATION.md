# Remembered speakers and transcription review

## Use

Open Library → a cloud-processed recording → Transcript → Name speakers.
Enter or correct the names and choose **Save names & update summaries**. This
updates the recording's transcript labels and summaries, not its source words,
timestamps, notes, or original audio.

After saving, **Remember this voice** creates an account-scoped voice profile
only after explicit confirmation that the person has given permission. Naming
someone alone does not enroll them. Enrollment needs at least five seconds of
usable, non-overlapping speaker audio within one retained processing window.
Older recordings without stable speaker maps may need to be processed again,
or replaced as enrollment sources with a recent recording. No additional audio
copy is stored.

Open **Remembered voices** in the same section to remove a profile. Removal
stops matching in subsequently started memory processing; it does not rewrite
existing memories or a processing job that has already loaded the profile.
Deleting the account also removes its voice directory. The separate Settings
voice profile continues to identify the wearer as **You**; remembering that
speaker by name can attach a saved name under the same matching rules.

## Identification safeguards

- At most 20 profiles are stored, encrypted with the account's existing DEK.
  Names, embeddings, model IDs, and enrollment metadata are sealed together.
  Listing profiles returns names and metadata, never embeddings.
- Enrollment and deletion require authentication. Saving enrollment rechecks
  the source recording's revision in a transaction, so a concurrent correction
  or deletion cannot leave an incorrectly named profile behind.
- Identical display names do not silently merge different enrollments. Use a
  distinct name, or explicitly remove the older profile before replacing it.
- Matching reuses the configured private speaker service and embeddings already
  calculated for within-recording diarization. There is no new client-side model
  download or change to Bluetooth, capture, or local speech preparation.
- A name requires matching embedding models, cosine similarity ≥0.84, a ≥0.12
  margin over another saved person, and a ≥0.12 margin over a competing voice in
  the same window. Conflicting matches across windows withhold the name.
- Automatic matches are estimates, stored separately from manual names. Manual
  corrections—including clearing a name—are authoritative. The naming panel
  marks automatic suggestions as unconfirmed. Summaries receive the distinction
  explicitly; topics, roles, and nearby mentioned names are not identity proof.
- Missing, short, overlapping, ambiguous, or unavailable voice evidence leaves
  anonymous labels. The recording and summary still process if matching fails.

These thresholds are conservative product defaults, not measured accuracy or
confidence percentages. Recognition error and transcription error still need
evaluation on consented, representative pendant recordings before claiming an
accuracy improvement. Do not lower thresholds just to produce more names.

## Transcription and summaries

The existing dedicated multilingual transcription model and automatic, bounded
local speech preparation remain in use. A non-empty result with incomplete word
coverage, speaker labels, or valid timings receives one additional annotation
review pass, limited to 15 seconds. A complete response or silence does not
receive that extra pass. Normal transport retries remain bounded by the same
review deadline. This can incur one extra model pass for affected windows.

Review accepts annotations only when the recognized text agrees (apart from
case and whitespace), or when the first response had no flat text. Signs,
currencies, and percentages must agree. The original flat text is preserved;
conflicting or failed review cannot replace it. Incomplete annotations fall back
to the complete window text, not a truncated speaker-formatted transcript.

New summary instructions prioritize concrete facts, decisions, actual next
steps, negations, conditions, numbers, and unresolved questions. They distinguish
confirmed names from acoustic estimates and warn about incomplete annotations;
they must not invent an owner, deadline, or missing speech. These are grounding
rules, not a claim that a prompt can repair unheard audio. Existing recordings
are not automatically retranscribed or rewritten.

## Verification

Backend tests cover identity ambiguity, encrypted account isolation, enrollment
revision checks, deletion, manual precedence, summary context, annotation review
agreement/disagreement, symbol preservation, and cancellation. Browser fixtures
exercise naming, summary/day refresh, explicit permission, canceled enrollment,
remember/forget, reload, capture guards, and retention of original evidence in
light/dark mobile and desktop layouts. No user recordings or real cloud account
are used by these automated fixtures.
