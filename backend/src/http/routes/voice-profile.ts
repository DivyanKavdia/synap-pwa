import express, { Router } from 'express';
import { config } from '../../config.js';
import { embedSpeakerAudio, speakerServiceConfigured } from '../../speaker/client.js';
import { deleteVoiceProfile, saveVoiceProfile, voiceProfileStatus, renameVoiceProfile } from '../../speaker/profile.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const ENROLL_MIN_MS = 5_000;
const ENROLL_MAX_MS = 30_000;

function displayName(value: unknown): string {
  const name = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  if (!name || name.length > 80 || /[:\x00-\x1f\x7f]/.test(name))
    throw new HttpError(400, 'invalid_name', 'Enter your name using up to 80 characters, without colons or line breaks.');
  return name;
}

export function voiceProfileRoutes(): Router {
  const router = Router();

  router.get(
    '/voice-profile',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const status = await voiceProfileStatus(req.uid, req.dek);
      res.status(200).json({
        available: speakerServiceConfigured(),
        supports_display_name: true,
        ...status,
        match_threshold: config.speaker.matchThreshold,
        privacy: {
          enrollment_audio_stored: false,
          embedding_encrypted: true,
          purpose: 'identify_self_speech',
        },
      });
    }),
  );

  router.post(
    '/voice-profile',
    requireAuth(),
    express.raw({ type: ['audio/wav', 'audio/x-wav'], limit: '2mb' }),
    handler<AuthedRequest>(async (req, res) => {
      if (!speakerServiceConfigured()) {
        throw new HttpError(
          503,
          'speaker_service_unavailable',
          'Voice profiling is not enabled on this Synap backend yet.',
        );
      }
      if (!Buffer.isBuffer(req.body) || req.body.length < 44) {
        throw new HttpError(400, 'bad_audio', 'Send a mono 16 kHz WAV voice sample.');
      }
      let name: string | undefined;
      const header = req.header('x-synap-voice-name');
      if (header !== undefined) {
        let decoded;
        try { decoded = decodeURIComponent(header); }
        catch { throw new HttpError(400, 'invalid_name', 'Enter a valid name.'); }
        name = displayName(decoded);
      }

      let embedded;
      try {
        embedded = await embedSpeakerAudio(req.body);
      } catch (cause) {
        throw new HttpError(
          503,
          'speaker_service_failed',
          (cause as Error).message || 'Voice profile service failed.',
        );
      }
      if (embedded.duration_ms < ENROLL_MIN_MS) {
        throw new HttpError(
          400,
          'sample_too_short',
          'Please record at least 5 seconds of clear speech.',
        );
      }
      if (embedded.duration_ms > ENROLL_MAX_MS) {
        throw new HttpError(400, 'sample_too_long', 'Voice enrollment is limited to 30 seconds.');
      }

      const status = await saveVoiceProfile(req.uid, req.dek, {
        embedding: embedded.embedding,
        model: embedded.model,
        sampleDurationMs: embedded.duration_ms,
        consentVersion: 1,
        ...(name ? { displayName: name } : {}),
      });
      res.status(201).json({
        available: true,
        supports_display_name: true,
        ...status,
        enrollment_audio_stored: false,
      });
    }),
  );

  router.patch('/voice-profile', requireAuth(), handler<AuthedRequest>(async (req, res) => {
    const name = displayName(req.body?.display_name);
    if (!await renameVoiceProfile(req.uid, req.dek, name))
      throw new HttpError(404, 'voice_profile_missing', 'Set up your voice profile first.');
    res.json({ available: speakerServiceConfigured(), supports_display_name: true, ...await voiceProfileStatus(req.uid, req.dek) });
  }));

  router.delete(
    '/voice-profile',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const removed = await deleteVoiceProfile(req.uid);
      res.status(200).json({ removed, enrolled: false });
    }),
  );

  return router;
}
