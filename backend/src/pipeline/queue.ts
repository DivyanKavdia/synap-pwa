/**
 * Cloud Tasks dispatch.
 *
 * Finalizing a recording enqueues one task rather than processing inline: an
 * hour of audio is minutes of Gemini calls, far past a request timeout, and the
 * phone that started it has usually gone back in a pocket. The queue also gives
 * retries, rate limiting and a dead-letter path for free.
 *
 * Normal task names are derived from the recording, so Cloud Tasks deduplicates
 * a double-finalize into a single processing run. Explicit user retries pass a
 * unique suffix so they are not blocked by Cloud Tasks' completed-task dedupe
 * window.
 */
import { CloudTasksClient } from '@google-cloud/tasks';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { processRecording } from './process.js';

let client: CloudTasksClient | null = null;

function tasks(): CloudTasksClient {
  client ??= new CloudTasksClient();
  return client;
}

function queuePath(): string {
  return tasks().queuePath(config.projectId, config.tasks.location, config.tasks.queue);
}

export async function enqueueProcessing(
  uid: string,
  recordingId: string,
  taskSuffix?: string,
): Promise<void> {
  // Local development and tests run the pipeline inline.
  if (!config.tasks.serviceUrl) {
    log.info('No Cloud Tasks target configured; processing inline', { uid, recordingId });
    void processRecording(uid, recordingId).catch((cause) =>
      log.error('Inline processing failed', { uid, recordingId, error: (cause as Error).message }),
    );
    return;
  }

  const payload = Buffer.from(JSON.stringify({ uid, recordingId }), 'utf8');
  const normalSuffix = String(Math.floor(Date.now() / 3_600_000));
  const suffix = (taskSuffix || normalSuffix).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || normalSuffix;
  const name = `${queuePath()}/tasks/${uid.replace(/-/g, '')}-${recordingId.replace(/-/g, '')}-${suffix}`;

  try {
    await tasks().createTask({
      parent: queuePath(),
      task: {
        name,
        httpRequest: {
          httpMethod: 'POST',
          url: `${config.tasks.serviceUrl}/v1/tasks/process`,
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          oidcToken: {
            serviceAccountEmail: config.tasks.invokerServiceAccount,
            audience: config.tasks.serviceUrl,
          },
        },
        dispatchDeadline: { seconds: 1800 },
      },
    });
  } catch (cause) {
    // ALREADY_EXISTS means the dedupe worked; anything else is a real failure.
    if ((cause as { code?: number }).code === 6) {
      log.info('Processing already queued', { uid, recordingId });
      return;
    }
    throw cause;
  }
}
