import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { sealJson, openJson, type Sealed } from '../../crypto/envelope.js';
import { paths } from '../../store/firestore.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { handler, HttpError } from '../errors.js';

export const CHAKSHU_TARGET = 'xiao-esp32s3-sense-8m';
export const associationBody = z
  .object({
    deviceId: z
      .string()
      .regex(/^SYNAP-[0-9A-F]{12}$/)
      .refine((id) => !/-(000000000000|FFFFFFFFFFFF)$/.test(id)),
    target: z.literal(CHAKSHU_TARGET),
  })
  .strict();
// Reject cached clients before parsing their image payload or accessing any model/store.
export function localMediaOnly(_req: Request, res: Response): void {
  res.status(410).json({
    error: {
      code: 'local_media_only',
      message: 'Photos and videos stay on your device. Cloud visual processing is disabled.',
      retryable: false,
    },
  });
}

// Association is account-scoped preference, not proof of exclusive hardware ownership.
// Public BLE IDs must never grant access to another account's content.
const devices = (uid: string) => paths.user(uid).collection('devices');
const binding = (uid: string, id: string) => ({ uid, scope: `device/${id}`, field: 'association' });

export function chakshuRoutes(): Router {
  const router = Router();
  router.get(
    '/devices',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const snapshot = await devices(req.uid).limit(100).get();
      res.json({
        devices: snapshot.docs.map((doc) =>
          openJson(req.dek, doc.data().sealedAssociation as Sealed, binding(req.uid, doc.id)),
        ),
      });
    }),
  );
  router.put(
    '/devices/chakshu',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const parsed = associationBody.safeParse(req.body);
      if (!parsed.success)
        throw new HttpError(
          400,
          'invalid_association',
          'A valid Chakshu device ID and target are required.',
        );
      const input = parsed.data;
      const value = { ...input, associatedAt: new Date().toISOString() };
      await devices(req.uid)
        .doc(input.deviceId)
        .set({
          sealedAssociation: sealJson(req.dek, value, binding(req.uid, input.deviceId)),
        });
      res.json({ device: value });
    }),
  );
  return router;
}
