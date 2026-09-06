import { config, loadSecrets } from './config.js';
import { keyring } from './crypto/keyring.js';
import { createApp } from './http/app.js';
import { log } from './util/log.js';

async function main(): Promise<void> {
  // Fail fast at boot rather than on the first user request: a revision that
  // cannot reach Secret Manager should never accept traffic.
  await loadSecrets();

  // Cloud Tasks calls the service back at this address and mints its OIDC
  // audience from it. Unset, finalize silently processes inline instead of
  // queueing — which works, but blocks the request and loses the queue's
  // retries. That is a difference worth seeing in the logs rather than
  // discovering when a long recording times out.
  if (!config.tasks.serviceUrl) {
    log.warn('SYNAP_SERVICE_URL is unset; recordings will process inline instead of via Cloud Tasks');
  }

  const server = createApp().listen(config.port, () => {
    log.info('Synap backend listening', {
      port: config.port,
      project: config.projectId,
      sttModel: config.gemini.transcribeModel,
      llmModel: config.gemini.memoryModel,
    });
  });

  const shutdown = (signal: string) => {
    log.info('Shutting down', { signal });
    server.close(() => {
      // Drop every unwrapped DEK before the process image can be captured.
      keyring.forgetAll();
      process.exit(0);
    });
    setTimeout(() => {
      keyring.forgetAll();
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((cause) => {
  log.error('Fatal startup error', { error: (cause as Error).message });
  process.exit(1);
});
