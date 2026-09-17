import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors.js';

const verifier = new OAuth2Client();
export function serviceIdentityMatches(payload: TokenPayload | undefined, email: string): boolean {
  return Boolean(email && payload?.sub && payload.email === email && payload.email_verified === true &&
    ['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss));
}

/** A Google service identity is never a substitute for a user's Synap session. */
export function requireServiceIdentity(audience: string, email: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!audience || !email) throw new HttpError(503, 'operations_disabled', 'Operational checks are not configured');
      const [scheme, token] = (req.header('authorization') || '').split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !token)
        throw new HttpError(401, 'missing_token', 'Service authorization required');
      const ticket = await verifier.verifyIdToken({ idToken: token, audience });
      if (!serviceIdentityMatches(ticket.getPayload(), email))
        throw new HttpError(403, 'forbidden', 'Unexpected service identity');
      next();
    } catch (cause) {
      next(cause instanceof HttpError ? cause : new HttpError(401, 'invalid_service_token', 'Rejected'));
    }
  };
}
