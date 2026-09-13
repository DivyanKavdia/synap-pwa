/** Publish one recording's derived data together. No network/model calls belong
 * in the transaction: Firestore can run its callback more than once. */
import { createHmac } from 'node:crypto';
import { FieldValue } from '@google-cloud/firestore';
import { openJson, sealJson } from '../crypto/envelope.js';
import { embedContent } from '../gemini/client.js';
import { firestore, patchProcessing, paths } from '../store/firestore.js';
import type {
  ConversationDoc,
  FollowUpDoc,
  PersonDoc,
  RecordingDoc,
  StructuredMemory,
} from '../store/types.js';
import { mergeAliasKeys, nameKey, normalizeName, sha256, topicKey } from '../util/ids.js';
import { log } from '../util/log.js';

const binding = (uid: string, scope: string, field: string) => ({ uid, scope, field });
const clean = (text: string | null | undefined) =>
  String(text || '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
const taskKey = (
  task: { task: string; owner?: string | null; kind?: string },
  startMs: number,
  dueDate?: string | null,
) =>
  JSON.stringify([
    clean(task.task),
    clean(task.owner),
    task.kind || 'commitment',
    startMs,
    dueDate || null,
  ]);
export const memoryRevision = (recording: RecordingDoc) =>
  sha256(JSON.stringify(recording.sealedMemory));

export async function indexMemory(
  uid: string,
  dek: Buffer,
  recording: RecordingDoc,
  memory: StructuredMemory,
  lease: string,
): Promise<void> {
  const recordingId = recording.recordingId;
  const revision = memoryRevision(recording);
  const id = (kind: string, key: unknown) =>
    createHmac('sha256', dek)
      .update(JSON.stringify([recordingId, kind, key]))
      .digest('hex');
  const now = new Date().toISOString();
  const prepared: ConversationDoc[] = [];
  // Sequential preparation keeps provider concurrency bounded. A failed optional
  // vector must never make an otherwise usable memory disappear.
  if (recording.indexedMemoryRevision !== revision)
    for (const [i, conversation] of memory.conversations.entries()) {
      // Keep long indexes alive between bounded provider calls, and stop a
      // superseded attempt before it pays for another optional embedding.
      await patchProcessing(uid, recordingId, lease, {
        progress: 0.8 + 0.15 * (i / memory.conversations.length),
      });
      let embedding: number[] | null = null;
      if (process.env.SYNAP_DISABLE_VECTOR_INDEX !== '1') {
        try {
          embedding = await embedContent(
            [
              conversation.title,
              conversation.summary,
              conversation.topics.join(', '),
              conversation.decisions.map((decision) => decision.text).join(' '),
            ]
              .filter(Boolean)
              .join('\n'),
            'RETRIEVAL_DOCUMENT',
          );
        } catch (cause) {
          log.warn('Embedding unavailable; using keyword retrieval', {
            uid,
            recordingId,
            error: (cause as Error).message,
          });
        }
      }
      const conversationId = id('conversation', i);
      prepared.push({
        conversationId,
        recordingId,
        day: recording.day,
        startMs: conversation.start_ms,
        endMs: conversation.end_ms,
        startedAt: new Date(Date.parse(recording.startedAt) + conversation.start_ms).toISOString(),
        sealedContent: sealJson(
          dek,
          {
            title: conversation.title,
            summary: conversation.summary,
            topics: conversation.topics,
            decisions: conversation.decisions,
            actionItems: conversation.action_items,
            followUps: conversation.follow_ups,
            participants: conversation.participants || [],
            mentionedPeople: conversation.mentioned_people || [],
            unresolvedQuestions: conversation.unresolved_questions || [],
            chapters: conversation.chapters || [],
            people: conversation.people.map((person) => person.name),
          },
          binding(uid, `conversation/${conversationId}`, 'content'),
        ),
        embedding,
        personIds: [],
        topicKeys: conversation.topics.map(topicKey).filter(Boolean).slice(0, 20),
        highlightCount: 0,
        createdAt: now,
      });
    }
  // Leave ample room for the encrypted documents and transaction overhead under
  // Firestore's request limit. Large indexes keep their text and provenance.
  if (Buffer.byteLength(JSON.stringify(prepared)) > 6 * 1024 * 1024) {
    for (const conversation of prepared) conversation.embedding = null;
  }
  await firestore().runTransaction(async (tx) => {
    const ref = paths.recording(uid, recordingId);
    const current = (await tx.get(ref)).data() as RecordingDoc | undefined;
    if (!current || current.deleting) throw new Error('Unknown recording');
    if (current.processingLease !== lease) throw new Error('Processing attempt was superseded');
    if (memoryRevision(current) !== revision) throw new Error('Memory changed during indexing');
    const ready = {
      state: 'ready' as const,
      progress: 1,
      errorCode: null,
      retryable: false,
      processingLease: null,
      indexedMemoryRevision: revision,
      updatedAt: new Date().toISOString(),
    };
    if (current.indexedMemoryRevision === revision) {
      tx.update(ref, ready);
      return;
    }

    const oldConversations = await tx.get(
      paths.conversations(uid).where('recordingId', '==', recordingId),
    );
    const oldTasks = await tx.get(paths.followUps(uid).where('recordingId', '==', recordingId));
    const previousPeople = new Set(
      current.indexedPersonIds ||
        oldConversations.docs.flatMap((doc) => (doc.data() as ConversationDoc).personIds || []),
    );
    const persons = new Map<string, PersonDoc>();
    const ids = new Map<string, string>();
    const existingPeople = new Map<string, PersonDoc>();
    // Resolve aliases inside the transaction so a concurrent confirmation wins.
    // All reads, including removed people, finish before the first write.
    for (const person of memory.people) {
      const normalized = normalizeName(person.name);
      if (!normalized || ids.has(normalized)) continue;
      const key = nameKey(dek, person.name);
      const aliases = await tx.get(
        paths.people(uid).where('aliasKeys', 'array-contains', key).limit(1),
      );
      const matches = aliases.empty
        ? await tx.get(paths.people(uid).where('nameKey', '==', key).limit(1))
        : aliases;
      const existing = matches.docs[0]?.data() as PersonDoc | undefined;
      const personId =
        existing?.personId ||
        createHmac('sha256', dek)
          .update('person:' + key)
          .digest('hex');
      if (existing) existingPeople.set(personId, existing);
      const pending = persons.get(personId);
      const profile =
        existing && (existing.confirmedByUser || existing.lastInteractionAt > recording.startedAt)
          ? existing.sealedProfile
          : sealJson(
              dek,
              {
                name: person.name,
                role: person.role,
                evidence: person.evidence,
                confidence: person.confidence,
              },
              binding(uid, `person/${personId}`, 'profile'),
            );
      persons.set(personId, {
        personId,
        nameKey: existing?.confirmedByUser ? existing.nameKey : key,
        aliasKeys: mergeAliasKeys(pending?.aliasKeys, existing?.aliasKeys, existing?.nameKey, key),
        sealedProfile: profile,
        confirmedByUser: existing?.confirmedByUser || false,
        firstSeenAt:
          existing?.firstSeenAt && existing.firstSeenAt < recording.startedAt
            ? existing.firstSeenAt
            : recording.startedAt,
        lastInteractionAt:
          existing?.lastInteractionAt && existing.lastInteractionAt > recording.startedAt
            ? existing.lastInteractionAt
            : recording.startedAt,
        // This historical field counts recordings mentioning a person. Count
        // this recording once, even if the model repeats aliases or we retry.
        conversationCount:
          (existing?.conversationCount || 0) + (previousPeople.has(personId) ? 0 : 1),
      });
      ids.set(normalized, personId);
    }
    for (const personId of previousPeople)
      if (!persons.has(personId)) {
        const person = (await tx.get(paths.people(uid).doc(personId))).data() as
          | PersonDoc
          | undefined;
        if (person) existingPeople.set(personId, person);
      }

    const oldByKey = new Map<string, FollowUpDoc>();
    for (const snapshot of oldTasks.docs) {
      const task = snapshot.data() as FollowUpDoc;
      const content = openJson<{ task: string; owner?: string | null; kind?: string }>(
        dek,
        task.sealedTask,
        binding(uid, `followUp/${task.followUpId}`, 'task'),
      );
      const key = taskKey(content, task.startMs, task.dueDate);
      const previous = oldByKey.get(key);
      // Reconcile legacy duplicates without reopening completed/dismissed work.
      if (
        !previous ||
        (previous.state === 'open' && task.state !== 'open') ||
        (previous.state === task.state && task.updatedAt > previous.updatedAt)
      )
        oldByKey.set(key, task);
    }
    const tasks = new Map<string, FollowUpDoc>();
    const conversations = prepared.map((doc, i) => ({
      ...doc,
      personIds: [
        ...new Set(
          memory.conversations[i]!.people.map((person) =>
            ids.get(normalizeName(person.name)),
          ).filter((value): value is string => Boolean(value)),
        ),
      ],
    }));
    for (const [i, conversation] of memory.conversations.entries()) {
      const items = [
        ...conversation.action_items.map((action) => ({
          task: action.task,
          owner: action.owner,
          kind: action.kind || 'commitment',
          dueDate: action.due_date,
          startMs: action.start_ms,
        })),
        ...conversation.follow_ups.map((followUp) => ({
          task: followUp.text,
          owner: followUp.owner,
          kind: 'follow-up',
          dueDate: null,
          startMs: followUp.start_ms,
        })),
      ];
      for (const item of items) {
        const key = taskKey(item, item.startMs, item.dueDate);
        const existing = oldByKey.get(key);
        const followUpId = existing?.followUpId || id('task', key);
        if (tasks.has(followUpId)) continue;
        const self = clean(item.owner) === 'self';
        tasks.set(followUpId, {
          followUpId,
          recordingId,
          conversationId: conversations[i]!.conversationId,
          sealedTask: sealJson(
            dek,
            { task: item.task, owner: item.owner, kind: item.kind },
            binding(uid, `followUp/${followUpId}`, 'task'),
          ),
          ownerType: self ? 'self' : 'other',
          counterpartyPersonId: self ? null : ids.get(normalizeName(item.owner || '')) || null,
          dueDate: item.dueDate,
          state: existing?.state || 'open',
          startMs: item.startMs,
          recordedAt: recording.startedAt,
          createdAt: existing?.createdAt || now,
          updatedAt: existing?.updatedAt || now,
        });
      }
    }
    const conversationIds = new Set(conversations.map((doc) => doc.conversationId));
    for (const snapshot of oldConversations.docs)
      if (!conversationIds.has(snapshot.id)) tx.delete(snapshot.ref);
    for (const snapshot of oldTasks.docs) if (!tasks.has(snapshot.id)) tx.delete(snapshot.ref);
    for (const person of persons.values())
      tx.set(paths.people(uid).doc(person.personId), person, { merge: true });
    for (const personId of previousPeople)
      if (!persons.has(personId) && existingPeople.has(personId)) {
        tx.update(paths.people(uid).doc(personId), {
          conversationCount: Math.max(0, existingPeople.get(personId)!.conversationCount - 1),
        });
      }
    for (const conversation of conversations)
      tx.set(paths.conversations(uid).doc(conversation.conversationId), {
        ...conversation,
        embedding: conversation.embedding ? FieldValue.vector(conversation.embedding) : null,
      });
    for (const task of tasks.values()) tx.set(paths.followUps(uid).doc(task.followUpId), task);
    tx.update(ref, { ...ready, indexedPersonIds: [...persons.keys()] });
  });
}
