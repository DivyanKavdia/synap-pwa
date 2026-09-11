# Day summaries and local speech enhancement

This update makes saved information the primary reading experience. Previous/next day, previous/next week, the calendar picker and date tiles share one bubbling date-change event. The strip shows the selected Monday–Sunday week, local recording counts and disabled future dates. Cloud restores coalesce rapid changes to the latest requested day instead of dropping it behind an in-flight request.

The day brief keeps all available executive summaries, with an expandable reading view and a source button for each recording. Conversation disclosures include full summaries, explicit participants, decisions, next steps with owners/dates, follow-ups and available key points/topics. They paginate three at a time without the old eight-conversation cutoff. Same-day refresh preserves expanded reading; switching days resets it. Failed local reads retain the last successful data with a visible status, and older asynchronous reads cannot overwrite newer results.

No additional summarization service or inference request is introduced. Content comes from existing processed memories. Pending audio stays visibly distinct from summarized content. Date activity counts cover recordings already stored in this browser, including hydrated cloud entries.

## Local speech copy

Open a saved recording in Library and choose **Preview clearer audio**. A dedicated Worker runs the bundled RNNoise model with a speech-preservation guard. Compare **Original** and **Enhanced**, then **Export enhanced copy** to keep the result. The preview exists for the current page session; it does not overwrite the stored source or rebuild its transcript/memory. New cloud processing windows use this treatment automatically before upload. See [automatic speech preparation](AUTOMATIC_SPEECH.md) for guards, fallbacks, and speaker continuity.

The limit is 20 minutes of mono PCM16 WAV at 16 or 48 kHz. Output is 16 kHz mono WAV, with model delay compensated to retain source timing. Model, Worker and UI are cached for offline use. See [model provenance and limits](../vendor/audio-enhancement/README.md) for pinned source, licenses, memory budget, resampling and measured tests. Real pendant listening and transcription comparisons remain necessary; synthetic suppression results do not establish improved recognition accuracy. Clipping, packet loss and overlapping voices cannot be reconstructed.

Firmware review is in the companion synap-firmware change: a small 70 Hz high-pass reduces DC/rumble before ADPCM. Double tap remains recording on/off; triple tap remains sleep/wake.

## Removed code

- Obsolete one-time `patch-audio-pipeline-v2.cjs` and `apply-end-to-end-audit.cjs` migrations, and the latter's branch-specific workflow. Their results already exist in production source.
- The bypassed product conversation decorator and its repeated full IndexedDB reads; current conversation markup is owned by `brain-ui.js`.
- Duplicate brain memory-event subscriptions, the unreachable Remember click implementation, and the old brief renderer that kept only three truncated summaries.
- Unproduced product settings/decorator styles, unused historical cache constants, and unused logo source formats from shell precaching. Source artwork remains available.

The Ask observer now watches relevant main-section insertions and writes only changed text. This removes its self-triggering descendant mutation loop. Day navigation also exposed an empty-day cost aggregation error, now fixed by initializing all totals to zero.

## Verification

`node --test tests/*.cjs` covers existing capture, processing, source and recovery contracts plus full-summary derivation, stale reads, cloud navigation races, observer settling and actual bundled WASM execution. `node tools/ui-smoke.cjs` exercises light/dark layouts at 320, 390, 768 and 1440 pixels; populated mobile/desktop cases include day/week/date-tile navigation, all ten test summaries, source identity, local enhancement comparison/export and live-capture exclusion. `node tools/audio-enhancement-smoke.cjs` checks actual model execution online and offline with production `sw.js`. Browser checks use generated recordings in an isolated localhost profile.
