/**
 * The read side of the second brain: the daily brief, people, the follow-up
 * inbox. Ask retrieval lives in ask-v3.ts.
 */

import { Router } from 'express';
import { z } from 'zod';
import { openJson, sealJson } from '../../crypto/envelope.js';
import { prepareMeeting } from '../../pipeline/meeting-preparation.js';
import { readDay, rebuildDay } from '../../pipeline/brief.js';
import { binding } from '../../pipeline/process.js';
import * as db from '../../store/firestore.js';
import { mergeAliasKeys, nameKey, normalizeName } from '../../util/ids.js';
import { editAction, ActionEditConflict } from '../../store/action-edits.js';
import type { FollowUpContent } from '../../store/types.js';
import { log } from '../../util/log.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

/**
 * Open one sealed record in a list without letting it take the list down.
 *
 * A list endpoint that decrypts inside `.map()` fails whole. One record whose
 * AES-GCM tag does not verify became a 500 on /v1/people, /v1/follow-ups and
 * /v1/voice-profile at once, so the People and Actions screens showed nothing
 * rather than showing everything that was still readable.
 *
 * The id is logged and the record skipped. The id is a per-user HMAC, not a
 * name, so this stays safe to read in Cloud Logging while telling us exactly
 * which records to examine.
 */
function openSealedRecord<T>(
  kind: string,
  uid: string,
  id: string,
  read: () => T,
  tally?: { opened: number; failed: number },
): T | null {
  try {
    const value = read();
    if (tally) tally.opened += 1;
    return value;
  } catch (cause) {
    if (tally) tally.failed += 1;
    log.error('Sealed record failed to open', {
      kind,
      uid,
      id,
      error: (cause as Error).message,
    });
    return null;
  }
}

/**
 * Report how a single request's sealed reads went, which is the one measurement
 * that separates the two explanations for a list of failures.
 *
 * Every record in one request is opened with the same unwrapped DEK. So if any
 * record opens while others fail, the key is demonstrably correct and the fault
 * is per-record: ciphertext bound to a place that no longer matches, which is
 * repairable. If nothing opens, the key itself is wrong for this data, which is
 * a different and much worse problem.
 *
 * Deciding that from outside would mean reading a user's documents. Deciding it
 * here costs one log line and no access to anything.
 */
function reportSealedReads(kind: string, uid: string, tally: { opened: number; failed: number }): void {
  if (!tally.failed) return;
  log.error('Sealed reads failed in one request', {
    kind,
    uid,
    opened: tally.opened,
    failed: tally.failed,
    verdict: tally.opened > 0 ? 'per-record binding mismatch' : 'no record opened with this key',
  });
}

/**
 * A person whose sealed profile will not open is not a server fault and not a
 * missing record. Saying so lets the PWA offer to remove or rebuild it instead
 * of showing a generic failure the user can do nothing about.
 */
const UNREADABLE_PERSON = () =>
  new HttpError(409, 'person_unreadable', 'This person\u2019s details cannot be opened.', false);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const actionDate = z.string().regex(DAY_PATTERN).refine(value => {
  const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value;
}, 'Choose a valid calendar date.').nullable();

const patchFollowUpBody = z.object({
  state: z.enum(['open', 'done', 'dismissed']).optional(),
  due_date: actionDate.optional(),
  check_in_date: actionDate.optional(),
  snoozed_until: actionDate.optional(),
  pinned: z.boolean().optional(),
  task: z.string().trim().min(1).max(600).optional(),
  owner: z.string().trim().max(80).refine(value => !/[:\x00-\x1f\x7f]/.test(value), 'Use a name without colons or line breaks.').optional(),
  revision: z.string().max(80).optional(),
});

const patchPersonBody = z.object({
  confirmed: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

export function brainRoutes(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Daily brief
  // -------------------------------------------------------------------------
  router.get(
    '/days/:day/brief',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const day = String(req.params.day);
      if (!DAY_PATTERN.test(day)) throw new HttpError(400, 'bad_request', 'Day must be YYYY-MM-DD');

      let brief = await readDay(req.uid, day, req.dek);
      if (!brief) brief = await rebuildDay(req.uid, day, req.dek);

      const recordings = await db.listRecordingsByDay(req.uid, day);
      res.status(200).json({
        day,
        ...brief,
        recording_count: recordings.length,
        pending: recordings.filter((recording) => recording.state !== 'ready').length,
      });
    }),
  );

  router.post(
    '/days/:day/brief/rebuild',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const day = String(req.params.day);
      if (!DAY_PATTERN.test(day)) throw new HttpError(400, 'bad_request', 'Day must be YYYY-MM-DD');
      res.status(200).json({ day, ...(await rebuildDay(req.uid, day, req.dek)) });
    }),
  );

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------
  router.get(
    '/people',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const people = await db.listPeople(req.uid);
      const tally = { opened: 0, failed: 0 };
      const body = {
        people: people.flatMap((person) => {
          const profile = openSealedRecord(
            'person',
            req.uid,
            person.personId,
            () =>
              openJson<{
                name: string;
                role: string;
                evidence: string;
                confidence: number;
              }>(
                req.dek,
                person.sealedProfile,
                binding(req.uid, `person/${person.personId}`, 'profile'),
              ),
            tally,
          );
          if (!profile) return [];
          return {
            person_id: person.personId,
            name: profile.name,
            role: profile.role,
            // The PWA renders model-derived identity differently from
            // user-confirmed identity; conflating them is how a wrong name
            // becomes permanent.
            confirmed_by_user: person.confirmedByUser,
            confidence: profile.confidence,
            evidence: profile.evidence,
            first_seen_at: person.firstSeenAt,
            last_interaction_at: person.lastInteractionAt,
            conversation_count: person.conversationCount,
          };
        }),
      };
      reportSealedReads('person', req.uid, tally);
      res.status(200).json({ ...body, unreadable: tally.failed });
    }),
  );

  router.get(
    '/people/:personId/preparation',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const personId = String(req.params.personId);
      const person = await db.getPerson(req.uid, personId);
      if (!person) throw new HttpError(404, 'not_found', 'Unknown person.');
      const profile = openSealedRecord('person', req.uid, personId, () =>
        openJson<{ name: string }>(
          req.dek,
          person.sealedProfile,
          binding(req.uid, `person/${personId}`, 'profile'),
        ),
      );
      if (!profile) throw UNREADABLE_PERSON();
      const [conversations, followUps] = await Promise.all([
        db.conversationsForPerson(req.uid, personId),
        db.listFollowUps(req.uid, 'open', 'all'),
      ]);
      res.json({
        person: { id: personId, name: profile.name },
        ...prepareMeeting(req.uid, req.dek, personId, conversations, followUps),
      });
    }),
  );

  router.patch(
    '/people/:personId',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const personId = String(req.params.personId);
      const body = patchPersonBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'Invalid person patch');

      const person = await db.getPerson(req.uid, personId);
      if (!person) throw new HttpError(404, 'not_found', 'Unknown person');

      const profile = openSealedRecord('person', req.uid, personId, () =>
        openJson<{
          name: string;
          role: string;
          evidence: string;
          confidence: number;
        }>(req.dek, person.sealedProfile, binding(req.uid, `person/${personId}`, 'profile')),
      );
      if (!profile) throw UNREADABLE_PERSON();

      const renamed = body.data.name !== undefined && body.data.name !== profile.name;
      if (renamed && !normalizeName(body.data.name ?? '')) {
        throw new HttpError(
          400,
          'bad_request',
          'A person needs a name with letters or digits in it',
        );
      }

      const name = renamed ? (body.data.name as string) : profile.name;
      const key = nameKey(req.dek, name);
      // Keep the old key matchable. The model will go on hearing the name it
      // heard before, and a rename that stopped matching would simply create a
      // second person on the next recording.
      const aliasKeys = mergeAliasKeys(person.aliasKeys, person.nameKey, key);

      await db.putPerson(req.uid, {
        ...person,
        nameKey: key,
        aliasKeys,
        sealedProfile: renamed
          ? sealJson(
              req.dek,
              { ...profile, name },
              binding(req.uid, `person/${personId}`, 'profile'),
            )
          : person.sealedProfile,
        // Correcting a name is a confirmation. Anything else would leave the
        // model free to overwrite the correction on the next recording.
        confirmedByUser: body.data.confirmed ?? (renamed ? true : person.confirmedByUser),
      });

      res.status(200).json({
        person_id: personId,
        name,
        confirmed_by_user: body.data.confirmed ?? (renamed ? true : person.confirmedByUser),
      });
    }),
  );

  router.delete(
    '/people/:personId',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const personId = String(req.params.personId);
      // Removing a profile does not remove its conversations or recordings.
      await db.deletePerson(req.uid, personId);
      res.status(200).json({ person_id: personId, deleted: true });
    }),
  );

  // -------------------------------------------------------------------------
  // Follow-up inbox
  // -------------------------------------------------------------------------
  router.get(
    '/follow-ups',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const state = String(req.query.state ?? 'open') as 'open' | 'done' | 'dismissed' | 'all';
      const owner = String(req.query.owner ?? 'all') as 'self' | 'other' | 'all';
      const items = await db.listFollowUps(req.uid, state, owner);
      const followUpTally = { opened: 0, failed: 0 };

      res.status(200).json({
        capabilities: { actions_version: 2 },
        follow_ups: items.flatMap((item) => {
          const task = openSealedRecord(
            'followUp',
            req.uid,
            item.followUpId,
            () =>
              openJson<FollowUpContent>(
                req.dek,
                item.sealedTask,
                binding(req.uid, `followUp/${item.followUpId}`, 'task'),
              ),
            followUpTally,
          );
          if (!task) return [];
          return {
            id: item.followUpId,
            task: task.task,
            kind: task.kind || 'commitment',
            owner: {
              type: task.owner ? item.ownerType : 'unknown',
              person_id: item.counterpartyPersonId,
              display_name: item.ownerType === 'self' ? 'Me' : task.owner,
            },
            due_date: item.dueDate,
            due_date_source: item.dueDateSource || 'recording',
            check_in_date: item.checkInDate || null,
            snoozed_until: item.snoozedUntil || null,
            pinned: item.pinned || false,
            evidence: task.evidence || '',
            context: task.context || '',
            condition: task.condition || '',
            due_evidence: task.dueEvidence || '',
            needs_review: item.sourceMissing || false,
            revision: item.updatedAt,
            state: item.state,
            source: {
              recording_id: item.recordingId,
              conversation_id: item.conversationId,
              start_ms: item.startMs,
              end_ms: item.endMs ?? item.startMs,
              recorded_at: item.recordedAt || null,
            },
          };
        }),
      });
      reportSealedReads('followUp', req.uid, followUpTally);
    }),
  );

  router.patch(
    '/follow-ups/:followUpId',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const body = patchFollowUpBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'Invalid follow-up patch');
      const followUpId = String(req.params.followUpId);
      let updated;
      try { updated = await editAction(req.uid, req.dek, followUpId, body.data); }
      catch (error) { if (error instanceof ActionEditConflict) throw new HttpError(409, 'changed', error.message); throw error; }
      if (!updated) throw new HttpError(404, 'not_found', 'Unknown follow-up');
      res.status(200).json({ id: followUpId, ...body.data, revision: updated.updatedAt });
    }),
  );

  return router;
}
