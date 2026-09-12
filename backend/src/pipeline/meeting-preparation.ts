import type { ConversationDoc, FollowUpDoc } from '../store/types.js';
import { openJson } from '../crypto/envelope.js';
import { binding } from './process.js';

export function prepareMeeting(uid:string,dek:Buffer,personId:string,conversations:ConversationDoc[],followUps:FollowUpDoc[]) {
  const recent=conversations.filter(c=>c.personIds.includes(personId)).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,12);
  const source=(c:ConversationDoc,startMs=c.startMs)=>({recording_id:c.recordingId,start_ms:startMs});
  const history=recent.map(c=>{
    const content=openJson<{title:string;summary:string;participants?:string[];mentionedPeople?:string[];unresolvedQuestions?:{text:string;start_ms:number}[]}>(dek,c.sealedContent,binding(uid,`conversation/${c.conversationId}`,'content'));
    return {title:content.title,summary:content.summary,started_at:c.startedAt,source:source(c),participants:content.participants||[],mentioned_people:content.mentionedPeople||[],questions:(content.unresolvedQuestions||[]).map(q=>({text:q.text,source:source(c,q.start_ms)}))};
  });
  const open=followUps.filter(f=>f.state==='open' && (f.counterpartyPersonId===personId || recent.some(c=>c.recordingId===f.recordingId && f.startMs>=c.startMs && f.startMs<=c.endMs))).map(f=>{
    const task=openJson<{task:string;owner:string;kind?:string}>(dek,f.sealedTask,binding(uid,`followUp/${f.followUpId}`,'task'));
    return {id:f.followUpId,text:task.task,owner:task.owner,kind:task.kind||'commitment',due_date:f.dueDate,source:{recording_id:f.recordingId,start_ms:f.startMs}};
  });
  return {history,open_actions:open,scope:'Recent related conversations and open actions. People may have been mentioned rather than present.'};
}
