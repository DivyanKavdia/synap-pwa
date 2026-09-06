import { Router } from 'express';
import { z } from 'zod';
import { openJson } from '../../crypto/envelope.js';
import { keyring } from '../../crypto/keyring.js';
import * as db from '../../store/firestore.js';
import type { UserProfile } from '../../store/types.js';
import { deleteUserAudio } from '../../store/gcs.js';
import { log } from '../../util/log.js';
import { approvePairing, claimPairing, createPairing } from '../auth-pairing.js';
import {
  issueTokens,
  refreshSession,
  requireAuth,
  upsertUserFromGoogle,
  verifyGoogleIdToken,
  type AuthedRequest,
} from '../auth.js';
import { HttpError, handler } from '../errors.js';
import { rateLimit } from '../rate-limit.js';

const exchangeBody = z.object({ id_token: z.string().min(16) });
const refreshBody = z.object({ refresh_token: z.string().min(16) });
const pairApproveBody = z.object({
  pair_id: z.string().min(16).max(128),
  id_token: z.string().min(16),
});
const pairClaimBody = z.object({
  pair_id: z.string().min(16).max(128),
  pair_secret: z.string().min(32).max(256),
});

export function authRoutes(): Router {
  const router = Router();

  /** Exchange a Google ID token for a Synap session. */
  router.post(
    '/auth/google',
    // Token exchange creates a user on first sign-in. Generous enough for a
    // shared network, tight enough that nothing enumerates it.
    rateLimit({ bucket: 'auth_google', limit: 30, windowMs: 60_000 }),
    handler(async (req, res) => {
      const body = exchangeBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'id_token is required');

      const payload = await verifyGoogleIdToken(body.data.id_token);
      const user = await upsertUserFromGoogle(payload);
      const tokens = await issueTokens(user);

      log.info('Sign-in', { uid: user.uid });
      res.status(200).json({
        ...tokens,
        user: { uid: user.uid, created_at: user.createdAt },
      });
    }),
  );

  /**
   * Start a short-lived cross-browser pairing transaction. This is used only
   * when the PWA is running in an iOS Web-Bluetooth browser where Google does
   * not support embedded Sign in with Google. Android/desktop keep using the
   * normal /auth/google exchange above.
   */
  router.post(
    '/auth/pair/start',
    // Unauthenticated and it writes a Firestore document per call, so it is
    // the cheapest thing in the API to abuse. A person pairing a phone needs
    // a handful of attempts; a script wants thousands.
    rateLimit({ bucket: 'pair_start', limit: 20, windowMs: 60_000 }),
    handler(async (_req, res) => {
      const pairing = await createPairing();
      res.status(201).json({
        pair_id: pairing.pairId,
        pair_secret: pairing.pairSecret,
        expires_in: pairing.expiresIn,
      });
    }),
  );

  /** Safari approves a pending transaction with a normal Google ID token. */
  router.post(
    '/auth/pair/approve',
    handler(async (req, res) => {
      const body = pairApproveBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'pair_id and id_token are required');

      const payload = await verifyGoogleIdToken(body.data.id_token);
      const user = await upsertUserFromGoogle(payload);
      const result = await approvePairing(body.data.pair_id, user.uid);

      if (result === 'missing') throw new HttpError(404, 'pairing_not_found', 'This sign-in request no longer exists');
      if (result === 'expired') throw new HttpError(410, 'pairing_expired', 'This sign-in request expired');
      if (result === 'consumed') throw new HttpError(409, 'pairing_consumed', 'This sign-in request was already used');

      log.info('Pairing approved', { uid: user.uid });
      res.status(200).json({ status: 'approved' });
    }),
  );

  /**
   * The originating Web-Bluetooth browser polls this endpoint. Only that
   * browser knows pair_secret. Once Safari approves the transaction, the claim
   * atomically consumes it and returns the same Synap session shape as the
   * existing Google exchange.
   */
  router.post(
    '/auth/pair/claim',
    // Claim is guessing-resistant by construction (32-byte secret), but a
    // limit keeps brute force off the Firestore bill as well as off the data.
    rateLimit({ bucket: 'pair_claim', limit: 60, windowMs: 60_000 }),
    handler(async (req, res) => {
      const body = pairClaimBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'pair_id and pair_secret are required');

      const claim = await claimPairing(body.data.pair_id, body.data.pair_secret);
      if (claim.status === 'pending') {
        res.status(202).json({ status: 'pending' });
        return;
      }
      if (claim.status === 'missing') throw new HttpError(404, 'pairing_not_found', 'This sign-in request no longer exists');
      if (claim.status === 'expired') throw new HttpError(410, 'pairing_expired', 'This sign-in request expired');
      if (claim.status === 'consumed') throw new HttpError(409, 'pairing_consumed', 'This sign-in request was already used');
      if (claim.status === 'invalid_secret') throw new HttpError(401, 'pairing_secret_invalid', 'Invalid pairing secret');

      const user = await db.getUser(claim.uid);
      if (!user) throw new HttpError(401, 'unknown_user', 'No such user');
      const tokens = await issueTokens(user);
      log.info('Paired sign-in', { uid: user.uid });
      res.status(200).json({
        status: 'approved',
        ...tokens,
        user: { uid: user.uid, created_at: user.createdAt },
      });
    }),
  );

  router.post(
    '/auth/refresh',
    handler(async (req, res) => {
      const body = refreshBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'refresh_token is required');
      res.status(200).json(await refreshSession(body.data.refresh_token));
    }),
  );

  /** Who am I. The profile is sealed at rest and opened only for its owner. */
  router.get(
    '/auth/me',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const profile = openJson<UserProfile>(req.dek, req.user.sealedProfile, {
        uid: req.uid,
        scope: `user/${req.uid}`,
        field: 'profile',
      });
      res.status(200).json({
        uid: req.uid,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        created_at: req.user.createdAt,
        audio_retention_days: req.user.audioRetentionDays,
      });
    }),
  );

  /** Sign out everywhere: invalidates every outstanding refresh token at once. */
  router.post(
    '/auth/signout',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      await db.bumpTokenGeneration(req.uid);
      keyring.forget(req.uid);
      res.status(204).end();
    }),
  );

  /**
   * Account deletion. Audio objects and Firestore documents go first; the
   * wrapped DEK is destroyed last, so an interruption anywhere in the sequence
   * still leaves every remaining byte permanently unreadable.
   */
  router.delete(
    '/auth/me',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      await deleteUserAudio(req.uid);
      await db.deleteUser(req.uid);
      keyring.forget(req.uid);
      log.info('Account deleted', { uid: req.uid });
      res.status(204).end();
    }),
  );

  return router;
}
