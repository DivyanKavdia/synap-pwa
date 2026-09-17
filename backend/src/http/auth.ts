/**
 * Google Sign-In and Synap session tokens.
 *
 * The PWA signs in with Google Identity Services and receives a Google ID
 * token. That token is exchanged here, once, for a Synap session:
 *
 *   Google ID token  ──►  POST /v1/auth/google  ──►  access (1h) + refresh (30d)
 *
 * The exchange exists rather than accepting the Google token on every request
 * for two reasons. A Google ID token from the implicit browser flow lasts an
 * hour with no refresh path, which would silently break background processing
 * the moment a phone stayed locked; and every request would then pay a token-
 * info round trip. A Synap refresh token lets the PWA keep uploading a long
 * capture without the user re-tapping "Sign in with Google" mid-conversation.
 *
 * Refresh tokens carry the user's `tokenGeneration`. Bumping that number on the
 * user document invalidates every outstanding refresh token at once, which is
 * what "sign out everywhere" and account deletion depend on.
 */

import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import { config, loadSecrets } from '../config.js';
import { keyring } from '../crypto/keyring.js';
import { sealJson } from '../crypto/envelope.js';
import * as db from '../store/firestore.js';
import type { UserDoc } from '../store/types.js';
import { newId } from '../util/ids.js';
import { HttpError } from './errors.js';

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

let oauthClient: OAuth2Client | null = null;
function google(): OAuth2Client {
  oauthClient ??= new OAuth2Client(config.googleClientId);
  return oauthClient;
}

export interface SessionClaims extends JWTPayload {
  uid: string;
  typ: 'access' | 'refresh';
  gen?: number;
}

export interface AuthedRequest extends Request {
  uid: string;
  user: UserDoc;
  dek: Buffer;
}

/** Verify a Google ID token and return its payload, or throw 401. */
export async function verifyGoogleIdToken(idToken: string): Promise<TokenPayload> {
  let payload: TokenPayload | undefined;
  try {
    const ticket = await google().verifyIdToken({
      idToken,
      audience: config.googleClientId,
    });
    payload = ticket.getPayload();
  } catch (cause) {
    throw new HttpError(401, 'invalid_google_token', (cause as Error).message);
  }

  if (!payload?.sub) throw new HttpError(401, 'invalid_google_token', 'Token has no subject');
  if (!GOOGLE_ISSUERS.has(payload.iss ?? '')) {
    throw new HttpError(401, 'invalid_google_token', 'Unexpected token issuer');
  }
  // An unverified address must never become the identity of a memory store.
  if (payload.email && payload.email_verified === false) {
    throw new HttpError(403, 'email_unverified', 'Verify your Google email address first');
  }
  return payload;
}

/** Find or provision the Synap user behind a Google identity. */
export async function upsertUserFromGoogle(payload: TokenPayload): Promise<UserDoc> {
  const existing = await db.findUserByGoogleSubject(payload.sub);
  const now = new Date().toISOString();

  if (existing) {
    await db.touchUser(existing.uid, now);
    return { ...existing, lastSeenAt: now };
  }

  const uid = newId();
  const { wrapped, dek } = await keyring.create(uid);
  const doc: UserDoc = {
    uid,
    googleSubject: payload.sub,
    sealedProfile: sealJson(
      dek,
      {
        email: payload.email ?? '',
        name: payload.name ?? '',
        picture: payload.picture ?? '',
      },
      { uid, scope: `user/${uid}`, field: 'profile' },
    ),
    key: wrapped,
    createdAt: now,
    lastSeenAt: now,
    tokenGeneration: 1,
    audioRetentionDays: config.storage.audioRetentionDays,
  };
  await db.putUser(doc);
  return doc;
}

async function signingKey(): Promise<Uint8Array> {
  return (await loadSecrets()).sessionSigningKey;
}

export async function issueTokens(
  user: UserDoc,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; token_type: 'Bearer' }> {
  const key = await signingKey();
  const now = Math.floor(Date.now() / 1000);

  const access = await new SignJWT({ uid: user.uid, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.session.issuer)
    .setSubject(user.uid)
    .setIssuedAt(now)
    .setExpirationTime(now + config.session.accessTokenTtlSeconds)
    .sign(key);

  const refresh = await new SignJWT({
    uid: user.uid,
    typ: 'refresh',
    gen: user.tokenGeneration,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.session.issuer)
    .setSubject(user.uid)
    .setIssuedAt(now)
    .setExpirationTime(now + config.session.refreshTokenTtlSeconds)
    .sign(key);

  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: config.session.accessTokenTtlSeconds,
    token_type: 'Bearer',
  };
}

export async function verifySessionToken(
  token: string,
  expected: 'access' | 'refresh',
): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(token, await signingKey(), {
      issuer: config.session.issuer,
      algorithms: ['HS256'],
    });
    const claims = payload as SessionClaims;
    if (claims.typ !== expected) {
      throw new HttpError(401, 'wrong_token_type', `Expected a ${expected} token`);
    }
    return claims;
  } catch (cause) {
    if (cause instanceof HttpError) throw cause;
    throw new HttpError(401, 'invalid_token', 'Session token is invalid or expired');
  }
}

/** Exchange a valid refresh token for a new pair, rejecting revoked generations. */
export async function refreshSession(refreshToken: string) {
  const claims = await verifySessionToken(refreshToken, 'refresh');
  const user = await db.getUser(claims.uid);
  if (!user) throw new HttpError(401, 'unknown_user', 'No such user');
  if ((claims.gen ?? 0) !== user.tokenGeneration) {
    throw new HttpError(401, 'token_revoked', 'This session was signed out');
  }
  return issueTokens(user);
}

/**
 * Express middleware. Resolves the caller, loads their user document and
 * unwraps their DEK once per request so handlers never touch KMS directly.
 */
export function requireAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization') ?? '';
      const [scheme, token] = header.split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !token) {
        throw new HttpError(401, 'missing_token', 'Authorization: Bearer <token> is required');
      }

      const claims = await verifySessionToken(token, 'access');
      const user = await db.getUser(claims.uid);
      if (!user) throw new HttpError(401, 'unknown_user', 'No such user');

      const authed = req as AuthedRequest;
      authed.uid = user.uid;
      authed.user = user;
      authed.dek = await keyring.unwrap(user.uid, user.key);
      next();
    } catch (cause) {
      next(cause);
    }
  };
}

/**
 * Guards the internal worker endpoint. Cloud Tasks signs each dispatch with an
 * OIDC token for our own service account; nothing else may drive processing.
 */
export function requireTaskAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization') ?? '';
      const [scheme, token] = header.split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !token) {
        throw new HttpError(401, 'missing_token', 'Task authorization required');
      }
      if (!config.tasks.serviceUrl || !config.tasks.invokerServiceAccount)
        throw new HttpError(503, 'invalid_task_token', 'Cloud Tasks identity is not configured');
      const ticket = await google().verifyIdToken({
        idToken: token,
        audience: config.tasks.serviceUrl,
      });
      const payload = ticket.getPayload();
      const expected = config.tasks.invokerServiceAccount;
      if (payload?.email !== expected || payload.email_verified !== true || !GOOGLE_ISSUERS.has(payload.iss)) {
        throw new HttpError(403, 'forbidden', 'Unexpected task invoker');
      }
      next();
    } catch (cause) {
      next(cause instanceof HttpError ? cause : new HttpError(401, 'invalid_task_token', 'Rejected'));
    }
  };
}
