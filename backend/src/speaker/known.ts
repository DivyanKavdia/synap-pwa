import { openJson, sealJson, type Sealed } from '../crypto/envelope.js';
import { firestore, paths } from '../store/firestore.js';
import { cosineSimilarity } from './audio.js';
import type { SpeakerEmbeddingResult } from './client.js';

export interface KnownSpeaker extends SpeakerEmbeddingResult {
  id: string;
  name: string;
  consentVersion: 1;
  createdAt: string;
  references?: { embedding: number[]; sourceId: string }[];
}
export class KnownSpeakerError extends Error {}
const bound = (uid:string) => ({uid,scope:'voiceProfiles/known',field:'profiles'});
const ref = (uid:string) => paths.user(uid).collection('voiceProfiles').doc('known');
const decode = (uid:string,dek:Buffer,data?:{sealedProfiles?:Sealed}):KnownSpeaker[] => data?.sealedProfiles ? openJson(dek,data.sealedProfiles,bound(uid)) : [];

export async function readKnownSpeakers(uid:string,dek:Buffer):Promise<KnownSpeaker[]> {
  const snapshot=await ref(uid).get();return decode(uid,dek,snapshot.data());
}
export const speakerViews=(profiles:KnownSpeaker[])=>profiles.map(({id,name,duration_ms,createdAt,references})=>({id,name,sample_duration_ms:duration_ms,created_at:createdAt,sample_count:references?.length || 1}));

export function updateDirectory(profiles:KnownSpeaker[],profile:KnownSpeaker):KnownSpeaker[] {
  const others=profiles.filter(item=>item.id!==profile.id);
  if(others.some(item=>item.name.normalize('NFKC').toLocaleLowerCase()===profile.name.normalize('NFKC').toLocaleLowerCase()))throw new KnownSpeakerError('A saved voice already uses this name. Remove it first to replace it, or use a distinct name.');
  if(others.length>=20)throw new KnownSpeakerError('You can remember up to 20 voices. Remove a saved voice first.');
  return [...others,profile];
}

export function addConfirmedSample(existing:KnownSpeaker, sample:KnownSpeaker):KnownSpeaker {
  if (existing.model !== sample.model) throw new KnownSpeakerError('The voice model changed. Remove and re-enroll this voice.');
  if (existing.name.normalize('NFKC').toLowerCase() !== sample.name.normalize('NFKC').toLowerCase()) throw new KnownSpeakerError('The confirmed name does not match the selected saved voice.');
  const references=existing.references || [{embedding:existing.embedding,sourceId:existing.id}];
  if (references.some(ref=>ref.sourceId===sample.id)) return existing;
  if (references.every(ref=>cosineSimilarity(ref.embedding,sample.embedding)<.78)) throw new KnownSpeakerError('This sample differs from the saved voice. Check the speaker or use a clearer recording.');
  return {...existing,references:[...references,{embedding:sample.embedding,sourceId:sample.id}].slice(-3)};
}

export async function saveKnownSpeaker(uid:string,dek:Buffer,profile:KnownSpeaker,recordingId:string,revision:string,existingId?:string):Promise<KnownSpeaker> {
  return firestore().runTransaction(async tx=>{
    const record=await tx.get(paths.recording(uid,recordingId));
    if(!record.exists || record.data()?.state!=='ready' || record.data()?.updatedAt!==revision)throw new KnownSpeakerError('This recording changed. Reload speaker names and try again.');
    const directory=ref(uid),snapshot=await tx.get(directory);
    const current=decode(uid,dek,snapshot.data());
    const existing=existingId ? current.find(item=>item.id===existingId) : undefined;
    if(existingId && !existing)throw new KnownSpeakerError('This saved voice was removed. Reload the voice list.');
    const saved=existing ? addConfirmedSample(existing,profile) : profile;
    const profiles=updateDirectory(current,saved);
    tx.set(directory,{sealedProfiles:sealJson(dek,profiles,bound(uid)),updatedAt:new Date().toISOString()});
    return saved;
  });
}

export async function forgetKnownSpeaker(uid:string,dek:Buffer,id:string):Promise<void> {
  await firestore().runTransaction(async tx=>{
    const directory=ref(uid),snapshot=await tx.get(directory);
    const profiles=decode(uid,dek,snapshot.data()).filter(item=>item.id!==id);
    if(!profiles.length)tx.delete(directory);
    else tx.set(directory,{sealedProfiles:sealJson(dek,profiles,bound(uid)),updatedAt:new Date().toISOString()});
  });
}

/** Require separation in both directions: voice→person and person→voice. */
export function identifyKnownSpeakers(voices:Map<string,SpeakerEmbeddingResult>,profiles:KnownSpeaker[]):Record<string,string> {
  const scores=[...voices].flatMap(([speaker,voice])=>profiles.filter(p=>p.model===voice.model).map(profile=>({speaker,profile,score:(()=>{const refs=profile.references?.length ? profile.references.map(r=>r.embedding) : [profile.embedding];const scores=refs.map(ref=>cosineSimilarity(voice.embedding,ref)).sort((a,b)=>b-a);return scores.slice(0,2).reduce((a,b)=>a+b,0)/Math.min(scores.length,2)})()})));
  const matches:Record<string,string>=Object.create(null);
  for(const speaker of voices.keys()) {
    const ranked=scores.filter(item=>item.speaker===speaker).sort((a,b)=>b.score-a.score),best=ranked[0];
    if(!best || best.score<.84 || (ranked[1] && best.score-ranked[1].score<.12))continue;
    const rival=scores.filter(item=>item.profile.id===best.profile.id && item.speaker!==speaker).sort((a,b)=>b.score-a.score)[0];
    if(rival && best.score-rival.score<.12)continue;
    matches[speaker]=best.profile.name;
  }
  return matches;
}

/** A weaker cross-window voice link cannot carry a contradicted name forward. */
export function mergeSpeakerIdentifications(mapping:Record<string,string>,voices:Iterable<string>,matches:Record<string,string>,identified:Record<string,string>,conflicts:Set<string>):void {
  for(const speaker of voices) {
    const name=matches[speaker],label=mapping[speaker];
    if(!label || conflicts.has(label))continue;
    if(!name || (identified[label] && identified[label]!==name)){delete identified[label];conflicts.add(label)}
    else identified[label]=name;
  }
}
