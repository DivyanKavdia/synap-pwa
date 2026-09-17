import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { sealJson, openJson, type Sealed } from '../../crypto/envelope.js';
import { createInteraction, interactionText, GeminiError, modelFailure } from '../../gemini/client.js';
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

const MAX_EXPLICIT_VISION_BYTES = 2 * 1024 * 1024;

// Association is account-scoped preference, not proof of exclusive hardware ownership.
// Public BLE IDs must never grant access to another account's content.
const devices = (uid: string) => paths.user(uid).collection('devices');
const binding = (uid: string, id: string) => ({ uid, scope: `device/${id}`, field: 'association' });

export function chakshuRoutes(): Router {
  const router = Router();

  // Visuals remain local by default. This is a deliberately narrow exception:
  // one explicit "what do you see" action uploads one bounded JPEG, asks for a
  // factual description, returns text, and asks Gemini not to retain interaction state.
  router.post(
    '/chakshu/describe',
    requireAuth(),
    express.raw({ type: 'image/jpeg', limit: MAX_EXPLICIT_VISION_BYTES }),
    handler<AuthedRequest>(async (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 4)
        throw new HttpError(400, 'invalid_image', 'Send one JPEG image to describe.');
      if (body.length > MAX_EXPLICIT_VISION_BYTES || body[0] !== 0xff || body[1] !== 0xd8 ||
          body[body.length - 2] !== 0xff || body[body.length - 1] !== 0xd9)
        throw new HttpError(400, 'invalid_image', 'Send one complete JPEG image up to 2 MiB.');
      try {
        const response = await createInteraction(
          {
            model: config.gemini.memoryModel,
            usage_label: 'chakshu-vision',
            system_instruction:
              'Describe only what is visibly supported by this image. Be concise and concrete. Do not identify people, infer sensitive traits, guess intent, or invent obscured details. Mention uncertainty when needed.',
            input: [
              {
                type: 'text',
                text: 'What do you see? Return a short factual description suitable for a personal memory entry.',
              },
              { type: 'image', data: body.toString('base64'), mime_type: 'image/jpeg' },
            ],
            generation_config: { temperature: 0.1, max_output_tokens: 220 },
          },
          req.signal,
        );
        const description = interactionText(response).replace(/\s+/g, ' ').trim().slice(0, 2000);
        if (!description)
          throw new HttpError(502, 'empty_description', 'The image service returned no description.');
        res.json({ description });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof GeminiError) {
          const failure = modelFailure(error);
          throw new HttpError(
            failure.retryable ? 503 : 502,
            failure.code,
            'The image could not be described right now. The photo remains on your device.',
          );
        }
        throw error;
      }
    }),
  );

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