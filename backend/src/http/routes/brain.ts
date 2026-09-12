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
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const patchFollowUpBody = z.object({
  state: z.enum(['open', 'done', 'dismissed']).optional(),
  due_date: z.string().regex(DAY_PATTERN).nullable().optional(),
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
      res.status(200).json({
        people: people.map((person) => {
          const profile = openJson<{
            name: string;
            role: string;
            evidence: string;
            confidence: number;
          }>(
            req.dek,
            person.sealedProfile,
            binding(req.uid, `person/${person.personId}`, 'profile'),
          );
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
      });
    }),
  );

  router.get(
    '/people/:personId/preparation',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const personId = String(req.params.personId);
      const person = await db.getPerson(req.uid, personId);
      if (!person) throw new HttpError(404, 'not_found', 'Unknown person.');
      const profile = openJson<{ name: string }>(
        req.dek,
        person.sealedProfile,
        binding(req.uid, `person/${personId}`, 'profile'),
      );
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

      const profile = openJson<{
        name: string;
        role: string;
        evidence: string;
        confidence: number;
      }>(req.dek, person.sealedProfile, binding(req.uid, `person/${personId}`, 'profile'));

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

      res.status(200).json({
        follow_ups: items.map((item) => {
          const task = openJson<{ task: string; owner: string; kind?: string }>(
            req.dek,
            item.sealedTask,
            binding(req.uid, `followUp/${item.followUpId}`, 'task'),
          );
          return {
            id: item.followUpId,
            task: task.task,
            kind: task.kind || 'commitment',
            owner: {
              type: item.ownerType,
              person_id: item.counterpartyPersonId,
              display_name: item.ownerType === 'self' ? 'Me' : task.owner,
            },
            due_date: item.dueDate,
            state: item.state,
            source: {
              recording_id: item.recordingId,
              conversation_id: item.conversationId,
              start_ms: item.startMs,
            },
          };
        }),
      });
    }),
  );

  router.patch(
    '/follow-ups/:followUpId',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const body = patchFollowUpBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'Invalid follow-up patch');
      const followUpId = String(req.params.followUpId);
      await db.patchFollowUp(req.uid, followUpId, {
        ...(body.data.state ? { state: body.data.state } : {}),
        ...(body.data.due_date !== undefined ? { dueDate: body.data.due_date } : {}),
      });
      res.status(200).json({ id: followUpId, ...body.data });
    }),
  );

  return router;
}
