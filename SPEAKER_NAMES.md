# Speaker names in transcripts

Open Library → a recording → Transcript → Name speakers. Each original speaker
label shows a short excerpt to help identify the speaker. Enter the names and
choose **Save names & update summaries**. Leave a name blank to restore its
original label.

This requires a signed-in Synap Cloud recording with a complete, speaker-labeled
transcript. Names apply to every occurrence of that label within this recording;
they do not enroll a voice or identify the person in other recordings. If a label
includes multiple people, this control cannot separate them.

Names are encrypted separately from the original transcript. Source words,
timestamps, audio, and local notes are preserved. Saving rebuilds the recording's
structured summary and daily brief using the confirmed names; this uses the
configured cloud summary model. Future memory refreshes retain the names. Ask
reads the attributed evidence and current summary. Previously saved merged
memories remain snapshots; recreate a merge to include later speaker edits.

Names and the rebuilt recording memory commit together after generation succeeds.
An error leaves the previous memory intact, and the editor keeps the draft for
retry. Concurrent edits or processing require reloading the speaker list. A daily
brief failure is reported separately after the recording save succeeds. Stop and
save an active recording before requesting summary regeneration.

Verification: backend tests cover label-only replacement, timestamps, validation,
encryption binding, model input, and atomic revision checks. The browser workflow
checks successful saves, failed saves and retry, local preservation, reload,
clearing names, recording guards, summary refresh, and narrow/light/dark layouts.
