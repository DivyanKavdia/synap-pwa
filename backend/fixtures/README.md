`readiness.wav` is a 6.885-second, mono, 16 kHz PCM16 synthetic fixture generated
with FFmpeg's Flite `slt` voice. It contains no user recording:

> This is a system check. Alex will send the project report tomorrow. We decided to review the report on Friday.

The deploy-only readiness endpoint sends it through the ordinary authenticated
upload, Cloud Tasks, transcription, memory and retrieval paths. It deletes only
its randomly generated `ops-probe-` account and audio afterward. Neither tokens
nor model response bodies are included in its report.
