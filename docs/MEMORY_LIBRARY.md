# Unified memory library

The Library is one searchable timeline for conversations, standalone audio,
photos and video. A capture with a soundtrack appears once: explicitly linked
photos/videos sit inside its audio card. Type filters match every type in that
card; search also includes media notes, people, outcomes, decisions and to-dos.
Favouriting linked media also finds the parent memory under Favourites.

Grouping is a view over existing stores. A visual must have an explicit audioId
and the same nonempty ownerUid as its audio; nearby timestamps never imply a
relationship. Original audio IDs, files, source links and export stay intact.
Unlinked visuals retain their own entries. The Add / import panel contains camera
and SD/import controls, rather than another list of memories.

Selecting a grouped capture deletes its linked device-only visuals along with
its audio only after the existing delete confirmation. Capturing media cannot
be deleted. A standalone visual deletion does not delete separately linked audio.
Photo/video bytes and paired soundtracks remain device-only, excluded from cloud
processing, inference and upload. Account changes invalidate media thumbnails.

## Extraction model and evidence

Managed memory extraction uses stable `gemini-3.8-flash` with high thinking in one
structured transcript request. Dedicated ASR, 1.5x pitch-preserving preparation,
query routing, cached transcript windows and deterministic day briefs continue
unchanged. The firmware and Bluetooth protocol are unaffected.

Extraction distinguishes completed outcomes from settled decisions and future
commitments, reconciles corrections and cancellations, preserves concrete facts,
and separates participants from people merely mentioned. New outcomes and
people require supporting source quotes. New-format decisions and actions are
checked against the normalized transcript as well. Legacy stored shapes remain
readable. Unknown follow-up owners remain unassigned, never guessed. Invalid
source ranges, unsupported quotes and duplicate actions are rejected.

Quote matching checks that the evidence exists; it does not prove that every
interpretation is correct. Model confidence is not calibrated identification.
Names still depend on transcript evidence or existing user-confirmed speakers.

Existing entries can use **Refresh memory** to run extraction on saved transcripts,
without resubmitting the audio for ASR. The update does not automatically reprocess
all older recordings or upload local-only captures.

Model support and routing were checked on 16 September 2026 against Google's
[model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
and [pricing](https://ai.google.dev/gemini-api/docs/pricing). The published standard
3.8 Flash rates through 31 December 2026 are $0.75 per million input tokens and
$3.75 per million output tokens, including thinking. Higher reasoning may consume
more output tokens; a lower rate is not a guarantee of lower total cost. The
historical cost illustration in the app remains explicitly historical.

## Validation

Pure tests cover same-owner grouping, original preservation, type/search/favourite
matching, source-language evidence, hallucinated quotes, task deduplication and
unassigned follow-ups. Provider requests are mocked, so these tests establish
routing and validation behavior, not measured summary accuracy. Browser journeys
exercise real IndexedDB, filters, expanded linked media, playback, deletion,
account changes and reload. Hardware performance requires testing on devices.
