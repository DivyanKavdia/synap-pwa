'use strict';

// Read configuration only; never read secret payloads or print environment values.
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function ready(resource) {
  requireThat(
    resource.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
    'Cloud Run resource is not Ready',
  );
}

function environment(container) {
  return Object.fromEntries((container.env || []).map(({ name, ...value }) => [name, value]));
}

function serving(service, revision) {
  ready(service);
  const traffic = (service.status.traffic || []).filter((t) => t.percent > 0);
  requireThat(
    traffic.length === 1 && traffic[0].percent === 100 && traffic[0].revisionName === revision,
    'Expected exactly 100% traffic on the recorded revision; stop and inspect traffic',
  );
}

function baseline(service) {
  const traffic = (service.status?.traffic || []).filter((t) => t.percent > 0);
  const revision = traffic[0]?.revisionName;
  requireThat(
    revision && service.status.latestCreatedRevisionName === service.status.latestReadyRevisionName,
    'A revision is pending',
  );
  serving(service, revision);
  requireThat(/^https:\/\//.test(service.status.url), 'Missing HTTPS service URL');
  return [revision, service.status.url].join('\t');
}

function origin(service, revision) {
  ready(revision);
  serving(service, revision.metadata.name);
  const containers = revision.spec?.containers;
  requireThat(containers?.length === 1, 'Expected a single backend container');
  const env = environment(containers[0]);
  for (const name of [
    'SYNAP_SERVICE_URL',
    'SYNAP_TASKS_QUEUE',
    'SYNAP_TASKS_LOCATION',
    'SYNAP_TASKS_INVOKER_SA',
    'SYNAP_GEMINI_API_KEY_SECRET',
    'SYNAP_SESSION_SIGNING_KEY_SECRET',
  ]) {
    requireThat(env[name]?.value, `Missing production setting: ${name}`);
  }
  requireThat(
    env.SYNAP_SERVICE_URL.value === service.status.url,
    'Cloud Tasks URL differs from the service URL',
  );
  return env.SYNAP_BUILD_SHA?.value || 'unknown';
}

function candidate(before, revision, envVars, expectedRevision) {
  ready(revision);
  requireThat(revision.metadata.name === expectedRevision, 'Unexpected candidate revision');
  const oldSpec = structuredClone(before.spec);
  const newSpec = structuredClone(revision.spec);
  requireThat(newSpec.containers?.length === 1, 'Expected a single backend container');
  const oldContainer = oldSpec.containers[0];
  const newContainer = newSpec.containers[0];
  requireThat(
    ['1', '1000m'].includes(newContainer.resources?.limits?.cpu),
    'Candidate must use one CPU',
  );
  requireThat(
    revision.metadata.annotations?.['run.googleapis.com/cpu-throttling'] === 'true',
    'Candidate must enable CPU throttling',
  );
  const expectedEnv = environment(oldContainer);
  const allowedUpdates = new Set([
    'SYNAP_SERVICE_URL',
    'SYNAP_GEMINI_STT_MODEL',
    'SYNAP_OPERATIONS_INVOKER_SA',
    'SYNAP_TRANSCRIPTION_SPEED',
    'SYNAP_GEMINI_MEMORY_MODEL',
    'SYNAP_GEMINI_QUERY_MODEL',
    'SYNAP_GEMINI_ASK_MODEL',
    'SYNAP_BUILD_SHA',
    'SYNAP_BUILD_TIME',
    'SYNAP_SPEAKER_SERVICE_URL',
    'SYNAP_SPEAKER_SERVICE_AUTH',
  ]);
  for (const entry of envVars.split(',')) {
    const separator = entry.indexOf('=');
    requireThat(separator > 0, 'Invalid deployment environment update');
    const name = entry.slice(0, separator);
    requireThat(allowedUpdates.has(name), 'Unexpected deployment environment update');
    expectedEnv[name] = { value: entry.slice(separator + 1) };
  }
  requireThat(
    isDeepStrictEqual(environment(newContainer), expectedEnv),
    'Candidate changed an unexpected environment variable or secret reference',
  );
  // Memory, identity, concurrency, timeout, volumes and probes must all survive.
  for (const container of [oldContainer, newContainer]) {
    delete container.image;
    delete container.env;
    delete container.resources.limits.cpu;
  }
  requireThat(
    isDeepStrictEqual(oldSpec, newSpec),
    'Candidate changed configuration outside image, environment updates and CPU',
  );
  // Revision bookkeeping is generated afresh, not runtime configuration.
  const runtimeAnnotations = (resource) =>
    Object.fromEntries(
      Object.entries(resource.metadata?.annotations || {}).filter(
        ([key]) =>
          ![
            'run.googleapis.com/cpu-throttling',
            'run.googleapis.com/operation-id',
            'serving.knative.dev/creator',
            'run.googleapis.com/build-id',
          ].includes(key) && !key.startsWith('run.googleapis.com/client-'),
      ),
    );
  requireThat(
    isDeepStrictEqual(runtimeAnnotations(before), runtimeAnnotations(revision)),
    'Candidate changed a runtime annotation outside CPU throttling',
  );
}

function staged(service, previous, revision, tag) {
  serving(service, previous);
  requireThat(
    service.status.latestCreatedRevisionName === revision &&
      service.status.latestReadyRevisionName === revision,
    'Another deployment changed the candidate; stop before moving traffic',
  );
  const target = service.status.traffic.find((t) => t.tag === tag && t.revisionName === revision);
  requireThat(/^https:\/\//.test(target?.url || ''), 'Candidate tag URL is missing');
  return target.url;
}

function health(value, sha) {
  requireThat(
    value.status === 'ok' && value.service === 'synap-backend' && value.commit === sha,
    'Health response does not match the expected backend commit',
  );
}

function unchanged(before, current) {
  requireThat(
    isDeepStrictEqual(before.spec, current.spec) &&
      isDeepStrictEqual(before.status, current.status),
    'Service changed during preflight; stop before staging',
  );
}

function rollbackAllowed(service, previous, revision) {
  requireThat(
    service.status?.latestCreatedRevisionName === revision,
    'Another deployment started; inspect traffic before rollback',
  );
  requireThat(
    (service.status.traffic || [])
      .filter((t) => t.percent > 0)
      .every((t) => [previous, revision].includes(t.revisionName)),
    'Traffic was moved by another operator; inspect before rollback',
  );
}

if (require.main === module) {
  const [command, file, ...args] = process.argv.slice(2);
  const read = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));
  try {
    const input = read(file);
    let output;
    if (command === 'baseline') output = baseline(input);
    else if (command === 'origin') output = origin(input, read(args[0]));
    else if (command === 'candidate') candidate(input, read(args[0]), args[1], args[2]);
    else if (command === 'staged') output = staged(input, ...args);
    else if (command === 'serving') serving(input, args[0]);
    else if (command === 'health') health(input, args[0]);
    else if (command === 'unchanged') unchanged(input, read(args[0]));
    else if (command === 'rollback-allowed') rollbackAllowed(input, ...args);
    else throw new Error('Unknown Cloud Run check');
    if (output) console.log(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  baseline,
  origin,
  candidate,
  staged,
  serving,
  health,
  unchanged,
  rollbackAllowed,
};
