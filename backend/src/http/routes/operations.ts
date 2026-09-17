import { Router } from 'express';
import { config } from '../../config.js';
import { runReadinessProbe } from '../../ops/readiness.js';
import { handler, HttpError } from '../errors.js';
import { requireServiceIdentity } from '../service-auth.js';

let running = false;
export function operationsRoutes(): Router {
  const router = Router();
  router.post('/readiness', requireServiceIdentity(config.tasks.serviceUrl, config.operations.invokerServiceAccount),
    handler(async (_req, res) => {
      if (running) throw new HttpError(409, 'probe_running', 'Readiness check already running');
      running = true;
      try {
        const result = await runReadinessProbe();
        res.status(result.ok ? 200 : 503).json(result);
      } finally { running = false; }
    }));
  return router;
}
