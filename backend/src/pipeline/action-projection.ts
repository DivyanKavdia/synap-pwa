/** Stable action projection. Human choices survive corrections and re-extraction. */
import { createHmac } from 'node:crypto';
import { openJson, sealJson } from '../crypto/envelope.js';
import type {
  FollowUpContent,
  FollowUpDoc,
  RecordingDoc,
  StructuredMemory,
} from '../store/types.js';
import { normalizeName } from '../util/ids.js';

const clean = (value: unknown) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
const bound = (uid: string, id: string) => ({ uid, scope: `followUp/${id}`, field: 'task' });

export function projectActions(
  uid: string,
  dek: Buffer,
  recording: RecordingDoc,
  memory: StructuredMemory,
  previous: FollowUpDoc[],
  people: Map<string, string>,
  conversationIds: string[],
  now: string,
): FollowUpDoc[] {
  const old = previous.map((doc) => ({
    doc,
    content: openJson<FollowUpContent>(dek, doc.sealedTask, bound(uid, doc.followUpId)),
  }));
  const pending = memory.conversations.flatMap((conversation, index) => [
    ...conversation.action_items.map((item) => ({
      text: item.task,
      owner: item.owner,
      kind: item.kind || 'commitment',
      evidence: item.evidence || '',
      due: item.due_date,
      dueEvidence: item.due_evidence || '',
      condition: item.condition || '',
      start: item.start_ms,
      end: item.end_ms,
      context: conversation.title,
      index,
    })),
    ...conversation.follow_ups.map((item) => ({
      text: item.text,
      owner: item.owner,
      kind: 'follow-up',
      evidence: item.evidence || '',
      due: item.due_date || null,
      dueEvidence: item.due_evidence || '',
      condition: item.condition || '',
      start: item.start_ms,
      end: item.end_ms,
      context: conversation.title,
      index,
    })),
  ]);
  const key = (item: (typeof pending)[number]) =>
    JSON.stringify([item.kind, clean(item.evidence || item.text), item.start, item.end]);
  const counts = new Map<string, number>();
  for (const item of pending) counts.set(key(item), (counts.get(key(item)) || 0) + 1);
  const used = new Set<string>(),
    result: FollowUpDoc[] = [],
    seen = new Set<string>();
  for (const item of pending) {
    const exact = JSON.stringify([
      clean(item.text),
      clean(item.owner),
      item.start,
      item.end,
      item.kind,
      item.due,
    ]);
    if (seen.has(exact)) continue;
    seen.add(exact);
    const sourceKey = key(item);
    let candidates = old.filter(
      ({ doc, content }) =>
        !used.has(doc.followUpId) &&
        clean(content.sourceTask || content.task) === clean(item.text) &&
        doc.startMs === item.start &&
        (content.kind || 'commitment') === item.kind,
    );
    if (!candidates.length && item.evidence && counts.get(sourceKey) === 1) {
      candidates = old.filter(
        ({ doc, content }) =>
          !used.has(doc.followUpId) &&
          (doc.sourceKey === sourceKey ||
            (clean(content.evidence) === clean(item.evidence) &&
              doc.startMs === item.start &&
              doc.endMs === item.end &&
              content.kind === item.kind)),
      );
    }
    if (candidates.length > 1) {
      const dated = candidates.filter(
        ({ doc, content }) =>
          (doc.sourceDueDate ?? doc.dueDate ?? null) === item.due &&
          clean(content.owner) === clean(item.owner),
      );
      if (dated.length) candidates = dated;
      // Older releases sometimes stored the exact same extraction twice.
      // Collapse only identical, unedited duplicates and retain completion.
      if (
        candidates.length > 1 &&
        candidates.every(
          ({ doc, content }) =>
            !doc.userEdited &&
            clean(content.owner) === clean(candidates[0]!.content.owner) &&
            (doc.dueDate || null) === (candidates[0]!.doc.dueDate || null),
        )
      ) {
        candidates.sort(
          (a, b) =>
            Number(b.doc.state === 'done') - Number(a.doc.state === 'done') ||
            Number(b.doc.state === 'dismissed') - Number(a.doc.state === 'dismissed'),
        );
        for (const duplicate of candidates.slice(1)) used.add(duplicate.doc.followUpId);
        candidates = candidates.slice(0, 1);
      }
    }
    const prior = candidates.length === 1 ? candidates[0] : undefined;
    const id =
      prior?.doc.followUpId ||
      createHmac('sha256', dek)
        .update(
          JSON.stringify([
            recording.recordingId,
            'action-v2',
            sourceKey,
            clean(item.text),
            clean(item.owner),
            item.due,
          ]),
        )
        .digest('hex');
    used.add(id);
    const owner = prior?.doc.userEdited?.owner ? prior.content.owner : item.owner;
    const content: FollowUpContent = {
      task: prior?.doc.userEdited?.task ? prior.content.task : item.text,
      sourceTask: item.text,
      owner,
      kind: item.kind,
      evidence: item.evidence,
      context: item.context,
      condition: item.condition,
      dueEvidence: item.dueEvidence,
    };
    const self = clean(owner) === 'self';
    const preserveDate = prior?.doc.userEdited?.dueDate || prior?.doc.dueDateSource === 'user';
    result.push({
      ...prior?.doc,
      followUpId: id,
      recordingId: recording.recordingId,
      conversationId: conversationIds[item.index] || null,
      sourceKey,
      sealedTask: sealJson(dek, content, bound(uid, id)),
      ownerType: self ? 'self' : owner ? 'other' : 'unknown',
      counterpartyPersonId: self ? null : people.get(normalizeName(owner)) || null,
      dueDate: preserveDate ? prior!.doc.dueDate : item.due,
      sourceDueDate: item.due,
      dueDateSource: preserveDate ? 'user' : 'recording',
      state: prior?.doc.state || 'open',
      startMs: item.start,
      endMs: item.end,
      recordedAt: recording.startedAt,
      createdAt: prior?.doc.createdAt || now,
      updatedAt: now,
      sourceMissing: false,
    });
  }
  // A disappeared extraction is a review item, not proof of cancellation. Keep
  // completed/dismissed history and manual changes instead of deleting them.
  for (const { doc } of old)
    if (!used.has(doc.followUpId)) result.push({ ...doc, sourceMissing: true });
  return result;
}
