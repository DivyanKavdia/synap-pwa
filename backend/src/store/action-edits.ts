import { openJson, sealJson } from '../crypto/envelope.js';
import { firestore, paths } from './firestore.js';
import type { FollowUpContent, FollowUpDoc, RecordingDoc } from './types.js';

export interface ActionEdit {
  state?: FollowUpDoc['state'];
  task?: string;
  owner?: string;
  due_date?: string | null;
  check_in_date?: string | null;
  snoozed_until?: string | null;
  pinned?: boolean;
  revision?: string;
}
export class ActionEditConflict extends Error {}

export async function editAction(
  uid: string,
  dek: Buffer,
  id: string,
  edit: ActionEdit,
): Promise<FollowUpDoc | null> {
  return firestore().runTransaction(async (tx) => {
    const ref = paths.followUps(uid).doc(id),
      snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    const current = snapshot.data() as FollowUpDoc;
    if (edit.revision && edit.revision !== current.updatedAt)
      throw new ActionEditConflict('This action changed. Reload it before saving.');
    const binding = { uid, scope: `followUp/${id}`, field: 'task' };
    const task = openJson<FollowUpContent>(dek, current.sealedTask, binding);
    const fields: Partial<FollowUpDoc> = { updatedAt: new Date().toISOString() };
    if (edit.state !== undefined) fields.state = edit.state;
    if (edit.task !== undefined || edit.owner !== undefined) {
      fields.sealedTask = sealJson(
        dek,
        {
          ...task,
          sourceTask: task.sourceTask || task.task,
          ...(edit.task !== undefined ? { task: edit.task } : {}),
          ...(edit.owner !== undefined ? { owner: edit.owner } : {}),
        },
        binding,
      );
      fields.userEdited = {
        ...current.userEdited,
        ...(edit.task !== undefined ? { task: true } : {}),
        ...(edit.owner !== undefined ? { owner: true } : {}),
      };
      if (edit.owner !== undefined) {
        fields.ownerType = edit.owner === 'self' ? 'self' : edit.owner ? 'other' : 'unknown';
        // A typed name is confirmed by the user, but does not identify a stored
        // person by first-name similarity. Preserve the link only if unchanged.
        fields.counterpartyPersonId =
          edit.owner === task.owner ? current.counterpartyPersonId : null;
      }
    }
    if (edit.due_date !== undefined) {
      fields.dueDate = edit.due_date;
      fields.dueDateSource = 'user';
      fields.userEdited = { ...current.userEdited, ...fields.userEdited, dueDate: true };
    }
    if (edit.check_in_date !== undefined) fields.checkInDate = edit.check_in_date;
    if (edit.snoozed_until !== undefined) fields.snoozedUntil = edit.snoozed_until;
    if (edit.pinned !== undefined) fields.pinned = edit.pinned;
    const recording = await tx.get(paths.recording(uid, current.recordingId));
    tx.update(ref, fields);
    if (recording.exists) tx.delete(paths.days(uid).doc((recording.data() as RecordingDoc).day));
    return { ...current, ...fields };
  });
}
