# Recording recovery and meeting tools

## What changes

- Short disconnect recovery is negotiated with compatible firmware using a per-page token and a last-complete-frame cursor. It preserves one journal and original frame sequence numbers. STOP drains pending frames before sealing. Settings shows the available recovery duration. Old firmware keeps its existing reconnect behavior.
- Local RNNoise preparation retains the untouched journal and uses a short-window waveform/energy check on automatic copies. Unsafe, failed, slow or unsupported processing falls back to the original. Digital-silence windows bypass the local model.
- Cloud transcription skips verified digital-silence windows and can trim their silent leading/trailing regions while preserving at least 500 ms of lead-in/tail. Word timestamps are offset back into the original recording. Quiet and uncertain audio remains; this is intentionally conservative, not a general ambient-noise speech gate.
- Speaker names can be supplemented with an explicitly confirmed sample for an existing remembered voice. Names alone and automatic matches never train a profile. Up to three distinct reference samples are kept encrypted; conflicting/model-incompatible samples are rejected. Matching retains the existing threshold and separation rules, using the best two references when available.
- New memory extraction includes chronological topic chapters, unanswered questions, actual actions and explicit spoken reminder suggestions with source times. Relative dates use capture context; uncertain dates remain null. Suggestions do not schedule notifications or contact people.
- Library → recording → Meeting details exposes chapter playback, decisions, actions, unanswered questions and saved audio-quality observations. Summary text remains the executive recap when structured detail is available.
- My actions → People → Prepare opens a compact inline view of recent related conversations and open actions. Related people can be mentioned rather than present. Local fallback identifies its narrower scope and does not guess whether old tasks are still open. A missing optional cloud person/recency index falls back to the latest 300 conversations without an infrastructure migration.
- Recording-quality observations flag clipping, very quiet audio and possible low-frequency interference. They do not modify capture or claim to identify the cause of noise. Saved missing/incomplete-frame information remains visible.

## Compatibility and limits

Control v2/audio v3/OTA v3 are unchanged. Recovery uses optional characteristic `4fa1234f-0000-1000-8000-00805f9b34fb`, protocol v1; its detailed format is documented in the firmware repository. The PWA must be deployed before users rely on this feature, and the pendant must be updated separately. No flash audio, standalone hours of recording or guaranteed background iOS capture is added.

Chapters and new reminder fields appear in newly processed memories or after a user-triggered memory rebuild. Existing recordings are not bulk retranscribed or rewritten. Existing speaker profiles continue matching and do not need replacement. Cloud voice matching still requires the configured private speaker service and cannot confidently separate every overlapping voice.

## Validation

Backend tests cover silence/quiet speech, timestamp preservation, reminder evidence, invalid dates/spans, additional confirmed voice references, and person-scoped preparation with completed actions excluded. Native firmware tests cover the actual ring/request code, limited memory, overflow, sequence wrap, session tokens, stale writes, connection callbacks, transport, codec bytes, stop concurrency and both hardware gesture contracts. Browser fixtures exercise old-firmware reconnect, buffered audio recovery into one journal, STOP before catch-up ends, chapter seek, preparation, speaker sample addition and compact light/dark layouts.

The tests use simulated devices/audio/accounts. They do not establish measured speech recognition accuracy, radio reliability, RAM headroom or battery life on a real S3/C3/Bluefy setup. Quiet speech is preserved conservatively; source audio remains the evidence.
