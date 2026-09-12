import { createHash } from 'node:crypto';
import { Router } from 'express';
import { openBytes, openJson, openText } from '../../crypto/envelope.js';
import { annotationsComplete } from '../../gemini/transcribe.js';
import { binding } from '../../pipeline/process.js';
import { extractSpeakerSample } from '../../speaker/audio.js';
import { embedSpeakerAudio, speakerServiceConfigured } from '../../speaker/client.js';
import { labelWords } from '../../speaker/diarization.js';
import { forgetKnownSpeaker, readKnownSpeakers, saveKnownSpeaker, speakerViews, KnownSpeakerError } from '../../speaker/known.js';
import { readSpeakerNames } from '../../speaker/names.js';
import * as db from '../../store/firestore.js';
import { readSealedSegment } from '../../store/gcs.js';
import type { TranscriptWord } from '../../store/types.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { handler, HttpError } from '../errors.js';

export function knownSpeakerRoutes():Router {
  const router=Router();
  router.get('/known-speakers',requireAuth(),handler<AuthedRequest>(async(req,res)=>{
    res.json({available:speakerServiceConfigured(),speakers:speakerViews(await readKnownSpeakers(req.uid,req.dek))});
  }));
  router.delete('/known-speakers/:id',requireAuth(),handler<AuthedRequest>(async(req,res)=>{
    if(!/^[a-f0-9]{40}$/.test(String(req.params.id)))throw new HttpError(400,'invalid_id','Invalid saved voice.');
    await forgetKnownSpeaker(req.uid,req.dek,String(req.params.id));res.json({removed:true});
  }));
  router.post('/recordings/:recordingId/remember-speaker',requireAuth(),handler<AuthedRequest>(async(req,res)=>{
    if(req.body?.consent!==true)throw new HttpError(400,'consent_required','Confirm you have permission to remember this voice.');
    if(!speakerServiceConfigured())throw new HttpError(503,'unavailable','Speaker recognition is temporarily unavailable.');
    const id=String(req.params.recordingId),label=String(req.body?.label||'');
    const existingId=req.body?.existing_id;
    if(existingId!==undefined && (typeof existingId!=='string'||!/^[a-f0-9]{40}$/.test(existingId)))throw new HttpError(400,'invalid_id','Invalid saved voice.');
    const recording=await db.getRecording(req.uid,id);
    if(!recording)throw new HttpError(404,'not_found','Unknown recording.');
    if(recording.state!=='ready' || req.body?.revision!==recording.updatedAt)throw new HttpError(409,'changed','Reload speaker names before remembering this voice.');
    const names=readSpeakerNames(req.uid,recording,req.dek);
    const name=Object.hasOwn(names,label)?names[label]:undefined;
    if(!recording.sealedSpeakerNames || !name || label==='S?')throw new HttpError(400,'name_required','Save and confirm this speaker’s name first. Unknown speakers cannot be enrolled.');
    let sample:null|ReturnType<typeof extractSpeakerSample>=null;
    for(const segment of await db.listSegments(req.uid,id)) {
      if(!segment.sealedWords || !segment.sealedTranscript || !segment.storagePath)continue;
      if(!segment.sealedSpeakerMap && recording.segmentCount>1)continue;
      const scope=`recording/${id}/segment/${segment.index}`;
      const raw=openJson<TranscriptWord[]>(req.dek,segment.sealedWords,binding(req.uid,scope,'words'));
      if(!annotationsComplete(openText(req.dek,segment.sealedTranscript,binding(req.uid,scope,'transcript')),raw))continue;
      const words=segment.sealedSpeakerMap ? labelWords(raw,openJson(req.dek,segment.sealedSpeakerMap,binding(req.uid,scope,'speaker-map'))) : raw;
      if(!words.some(word=>word.speaker===label))continue;
      const sealed=await readSealedSegment(segment.storagePath);if(!sealed)continue;
      const audio=openBytes(req.dek,sealed,binding(req.uid,scope,'audio'));
      sample=extractSpeakerSample(audio,words,label,segment.startMs,5000,8000);
      if(sample)break;
    }
    if(!sample)throw new HttpError(409,'no_sample','This speaker needs at least 5 seconds of clear, non-overlapping retained audio. Try a recent recording.');
    const embedded=await embedSpeakerAudio(sample.wav);
    const profile={...embedded,duration_ms:sample.speechMs,id:createHash('sha256').update(id+'\0'+label).digest('hex').slice(0,40),name,consentVersion:1 as const,createdAt:new Date().toISOString()};
    let saved=profile;
    try {saved=await saveKnownSpeaker(req.uid,req.dek,profile,id,recording.updatedAt,existingId);}
    catch(error){if(error instanceof KnownSpeakerError)throw new HttpError(409,'not_saved',error.message);throw error;}
    res.json({speaker:speakerViews([saved])[0]});
  }));
  return router;
}
