import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { errorHandler } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { brainRoutes } from './routes/brain.js';
import { memoryToolRoutes } from './routes/memory-tools.js';
import { recordingRoutes } from './routes/recordings.js';
import { taskRoutes } from './routes/tasks.js';
import { voiceProfileRoutes } from './routes/voice-profile.js';

/**
 * CORS.
 *
 * The PWA is served from GitHub Pages, so this is a genuine cross-origin API.
 * The allowlist is exact-match on origin — no wildcards, no reflecting whatever
 * Origin arrives — because these endpoints carry a bearer token that grants
 * access to someone's recorded life.
 */
function cors() {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Idempotency-Key, X-Synap-Client, X-Synap-Schema, X-Synap-Sha256, X-Synap-Start-Ms, X-Synap-End-Ms',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '3600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

function requestLog() {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log.info('request', {
        method: req.method,
        // Path only — never the query string, which can carry a person's name.
        path: req.route?.path ?? req.path,
        status: res.statusCode,
        ms: Math.round(ms),
      });
    });
    next();
  };
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(securityHeaders());
  app.use(cors());
  app.use(requestLog());

  // Segment/voice upload routes parse their own raw audio bodies; JSON parsing
  // ignores audio/wav and remains scoped to normal API payloads.
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', version: 1 });
  });

  app.use('/v1', authRoutes());

  // Task routes MUST be mounted before any router that calls
  // router.use(requireAuth()).
  //
  // Express runs a router's path-less middleware for every request that enters
  // it, before matching a single route. Every router below applies requireAuth
  // that way, so mounting them first meant POST /v1/tasks/process entered
  // recordingRoutes, was checked as a user session token, and was rejected in
  // ~2ms — a Cloud Tasks OIDC token is not a Synap session JWT and never could
  // be. Cloud Tasks then retried to its 10-minute backoff ceiling and gave up,
  // so no recording was ever processed by the queue. Only the PWA's
  // /process-now fallback completed anything, which is why short recordings
  // looked fine and long ones silently came back partial.
  app.use('/v1', taskRoutes());

  app.use('/v1', recordingRoutes());
  app.use('/v1', brainRoutes());
  app.use('/v1', memoryToolRoutes());
  app.use('/v1', voiceProfileRoutes());

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } });
  });
  app.use(errorHandler());

  return app;
}
