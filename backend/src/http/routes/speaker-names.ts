import { Router } from 'express';
import { openJson, sealJson } from '../../crypto/envelope.js';
import { extractMemory } from '../../gemini/memory.js';
import { formatMs } from '../../gemini/transcribe.js';
import { rebuildDay } from '../../pipeline/brief.js';
import { binding } from '../../pipeline/process.js';
import { materializeTranscript } from '../../pipeline/source-materialize.js';
import { applySpeakerNames, readSpeakerNames, transcriptSpeakers, validateSpeakerNames } from '../../speaker/names.js';
import * as db from '../../store/firestore.js';
import type { StructuredMemory } from '../../store/types.js';
import { log } from '../../util/log.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { handler, HttpError } from '../errors.js';

export function speakerNameRoutes(): Router {
  const router = Router();
  router.get('/recordings/:recordingId/speakers', requireAuth(), handler<AuthedRequest>(async (req, res) => {
    const id = String(req.params.recordingId), recording = await db.getRecording(req.uid, id);
    if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');
    const transcript = await materializeTranscript(req.uid, recording, req.dek);
    res.json({ speakers: transcriptSpeakers(transcript.originalText), speaker_names: readSpeakerNames(req.uid, recording, req.dek), names_confirmed:Boolean(recording.sealedSpeakerNames), revision: recording.updatedAt });
  }));
  router.post('/recordings/:recordingId/speakers', requireAuth(), handler<AuthedRequest>(async (req, res) => {
    const id = String(req.params.recordingId), recording = await db.getRecording(req.uid, id);
    if (!recording) throw new HttpError(404, 'not_found', 'Unknown recording');
    if (recording.state !== 'ready' || !recording.sealedMemory) throw new HttpError(409, 'not_ready', 'Wait for this recording to finish processing.');
    if (req.body?.revision !== recording.updatedAt) throw new HttpError(409, 'changed', 'This recording changed. Reload speaker names before saving.');
    const segments = await db.listSegments(req.uid,id);
    const source = await materializeTranscript(req.uid, recording, req.dek,segments);
    if (!source.originalText.trim()) throw new HttpError(409, 'no_transcript', 'No transcript is available.');
    if (!source.complete) throw new HttpError(409, 'incomplete_transcript', 'Some transcript windows are missing. Recover the full transcript before updating summaries.');
    let names;
    try { names = validateSpeakerNames(req.body?.speaker_names, source.originalText); }
    catch (error) { throw new HttpError(400, 'invalid_names', (error as Error).message); }
    const oldNames = readSpeakerNames(req.uid, recording, req.dek);
    const same = JSON.stringify(Object.entries(names).sort()) === JSON.stringify(Object.entries(oldNames).sort());
    let memory: StructuredMemory;
    let revision = recording.updatedAt;
    if (same) memory = openJson<StructuredMemory>(req.dek, recording.sealedMemory, binding(req.uid, `recording/${id}`, 'memory'));
    else {
      const highlights = await db.listHighlights(req.uid, id);
      memory = await extractMemory({ transcript: applySpeakerNames(source.originalText, names), confirmedSpeakers: names,
        transcriptWarnings:segments.filter(segment=>segment.transcriptionReview?.annotationsComplete===false).map(segment=>`The window at ${formatMs(segment.startMs)} has incomplete speaker/timing annotations. Do not infer an owner from its neighbouring speaker.`),
        durationMs: recording.durationMs, language: recording.language, knownPeople: [], highlightOffsetsMs: highlights.map(h => h.offsetMs) });
    }
    if(!same || !recording.sealedSpeakerNames) {
      // Generate first, then commit together. Failure or a concurrent edit keeps the old memory intact.
      const saved = await db.saveSpeakerMemory(req.uid, id, recording.updatedAt, {
        sealedSpeakerNames: sealJson(req.dek, names, binding(req.uid, `recording/${id}`, 'speaker-names')),
        sealedMemory: sealJson(req.dek, memory, binding(req.uid, `recording/${id}`, 'memory')),
      });
      if (!saved) throw new HttpError(409, 'changed', 'This recording changed while rebuilding. Reload speaker names and try again.');
      revision = saved;
    }
    let dayUpdated = true;
    try { await rebuildDay(req.uid, recording.day, req.dek); }
    catch { dayUpdated = false; log.warn('Speaker names saved; daily brief refresh pending', { uid: req.uid, recordingId: id }); }
    res.json({ ...memory, recording_id: id, started_at: recording.startedAt, day: recording.day, duration_ms: recording.durationMs,
      transcript: applySpeakerNames(source.originalText, names), raw_transcript: source.originalText, speaker_names: names, names_confirmed:true, revision, day_updated: dayUpdated });
  }));
  return router;
}
