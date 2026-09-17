'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const checks = require('../infra/check-cloud-run.cjs');
const root = path.resolve(__dirname, '..');

function fixture() {
  const revision = {
    metadata: {
      name: 'synap-backend-old',
      annotations: {
        'run.googleapis.com/cpu-throttling': 'false',
        'autoscaling.knative.dev/maxScale': '20',
      },
    },
    spec: {
      serviceAccountName: 'synap-api@example.test',
      timeoutSeconds: 1800,
      containerConcurrency: 80,
      containers: [
        {
          image: 'example.test/backend@sha256:old',
          resources: { limits: { cpu: '2', memory: '2Gi' } },
          env: Object.entries({
            SYNAP_SERVICE_URL: 'https://production.example.test',
            SYNAP_TASKS_QUEUE: 'synap-processing',
            SYNAP_TASKS_LOCATION: 'asia-south1',
            SYNAP_TASKS_INVOKER_SA: 'tasks@example.test',
            SYNAP_GEMINI_API_KEY_SECRET: 'gemini-key',
            SYNAP_SESSION_SIGNING_KEY_SECRET: 'session-key',
            SYNAP_BUILD_SHA: 'old-sha',
            EXTRA_SETTING: 'preserve-me',
          })
            .map(([name, value]) => ({ name, value }))
            .concat([
              {
                name: 'SECRET_MOUNT',
                valueFrom: { secretKeyRef: { name: 'existing-secret', key: '7' } },
              },
            ]),
          ports: [{ containerPort: 8080 }],
          startupProbe: {
            httpGet: { path: '/health', port: 8080 },
            periodSeconds: 5,
            failureThreshold: 6,
          },
        },
      ],
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  };
  return {
    revisions: { [revision.metadata.name]: revision },
    service: {
      metadata: { resourceVersion: '1' },
      spec: { template: { metadata: revision.metadata, spec: revision.spec } },
      status: {
        url: 'https://production.example.test',
        latestCreatedRevisionName: revision.metadata.name,
        latestReadyRevisionName: revision.metadata.name,
        conditions: [{ type: 'Ready', status: 'True' }],
        traffic: [{ revisionName: revision.metadata.name, percent: 100 }],
      },
    },
  };
}

// Exercise the actual shell orchestrator. Only its external commands are fakes;
// all JSON/configuration checks run unchanged, without credentials or a network.
const fake = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const dir = process.env.DEPLOY_FIXTURE;
const file = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(file));
const scenario = process.env.DEPLOY_SCENARIO;
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({command,args})+'\n');
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const out = value => console.log(typeof value === 'string' ? value : JSON.stringify(value));
const flag = name => args.find(a => a.startsWith(name+'='))?.slice(name.length+1);
if (command === 'curl') {
  const url = args.at(-1);
  if (url.endsWith('/ops/readiness')) {
    const tagged = url.startsWith('https://candidate.');
    const ok = !(tagged && scenario === 'candidate-readiness') && !(!tagged && scenario === 'live-readiness');
    const sha = state.revisions[state.candidate].spec.containers[0].env.find(e=>e.name==='SYNAP_BUILD_SHA').value;
    fs.writeFileSync(args[args.indexOf('--output')+1], JSON.stringify({ok,commit:sha,checks:[{name:'cloud_tasks_and_memory',ok}]}));
    out(ok ? '200' : '503');
    process.exit(0);
  }
  const tagged = url.startsWith('https://candidate.');
  const active = state.service.status.traffic.find(t => t.percent === 100).revisionName;
  const revision = tagged ? state.candidate : active;
  const sha = state.revisions[revision].spec.containers[0].env.find(e=>e.name==='SYNAP_BUILD_SHA').value;
  const bad = (tagged && scenario === 'candidate-health') || (!tagged && active===state.candidate && ['live-health','rollback-error'].includes(scenario));
  out({status:'ok', service:'synap-backend', commit:bad ? 'wrong-sha' : sha});
} else if (command === 'gcloud') {
  const operation = args.slice(0,3).join(' ');
  if (operation === 'auth print-identity-token --audiences=https://production.example.test') {
    out('synthetic-test-identity');
  } else if (operation === 'run services describe') {
    if (args[3] === 'synap-speaker') out('https://speaker.example.test');
    else out(state.service);
  } else if (operation === 'run revisions describe') {
    out(state.revisions[args[3]]);
  } else if (operation === 'run deploy synap-backend') {
    if (!args.includes('--no-traffic')) throw Error('Staging must not receive production traffic');
    const name = 'synap-backend-'+flag('--revision-suffix');
    const revision = structuredClone(state.revisions['synap-backend-old']);
    revision.metadata.name = name;
    revision.metadata.annotations['run.googleapis.com/cpu-throttling'] = String(args.includes('--cpu-throttling'));
    const container = revision.spec.containers[0];
    container.resources.limits.cpu = flag('--cpu');
    container.image = flag('--image');
    const env = new Map(container.env.map(e=>[e.name,e]));
    for (const update of flag('--update-env-vars').split(',')) {
      const i = update.indexOf('=');
      env.set(update.slice(0,i), {name:update.slice(0,i), value:update.slice(i+1)});
    }
    if (scenario === 'lost-secret') env.delete('SYNAP_GEMINI_API_KEY_SECRET');
    if (scenario === 'changed-queue') env.set('SYNAP_TASKS_QUEUE', {name:'SYNAP_TASKS_QUEUE', value:'wrong-queue'});
    container.env = [...env.values()];
    if (scenario === 'changed-memory') container.resources.limits.memory = '1Gi';
    if (scenario === 'wrong-cpu') container.resources.limits.cpu = '2';
    state.revisions[name] = revision;
    state.candidate = name;
    state.service.spec.template = {metadata:revision.metadata, spec:revision.spec};
    state.service.status.latestCreatedRevisionName = name;
    state.service.status.latestReadyRevisionName = name;
    state.service.status.traffic.push({revisionName:name, percent:0, tag:flag('--tag'), url:'https://candidate.example.test'});
    if (scenario === 'concurrent') state.service.status.latestCreatedRevisionName = 'another-deploy';
    save();
  } else if (operation === 'run services update-traffic') {
    if (flag('--remove-tags')) {
      state.service.status.traffic = state.service.status.traffic.flatMap(t => {
        if(t.tag!==flag('--remove-tags')) return [t];
        const {tag,url,...target}=t;
        return target.percent ? [target] : [];
      });
    } else {
      const [revision,percent] = flag('--to-revisions').split('=');
      if (scenario==='rollback-error' && revision==='synap-backend-old') process.exit(1);
      state.service.status.traffic = state.service.status.traffic.map(t=>({...t,percent:t.revisionName===revision ? Number(percent) : 0}));
      if (!state.service.status.traffic.some(t=>t.revisionName===revision)) state.service.status.traffic.push({revisionName:revision,percent:Number(percent)});
      save();
      // A failed CLI can still have changed traffic. The shell must roll back.
      if (scenario==='promotion-error' && revision===state.candidate) process.exit(1);
    }
    save();
  } else if (!['artifacts repositories describe','storage buckets describe','builds submit'].some(op=>args.join(' ').startsWith(op))) {
    throw Error('Unexpected gcloud mutation: '+args.join(' '));
  }
} else if (command === 'npm' && scenario === 'test-failure') process.exit(1);
`;

for (const scenario of [
  'success',
  'candidate-health',
  'candidate-readiness',
  'lost-secret',
  'changed-queue',
  'changed-memory',
  'wrong-cpu',
  'concurrent',
  'live-health',
  'live-readiness',
  'promotion-error',
  'rollback-error',
  'test-failure',
]) {
  test(`deployment: ${scenario}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synap-deploy-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(fixture()));
      for (const name of ['gcloud', 'curl', 'npm', 'ffmpeg', 'sleep']) {
        fs.writeFileSync(path.join(dir, name), fake, { mode: 0o700 });
      }
      const result = spawnSync('bash', [path.join(root, 'infra/deploy.sh')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          DEPLOY_FIXTURE: dir,
          DEPLOY_SCENARIO: scenario,
          PROJECT_ID: 'example-project',
          GITHUB_SHA: 'new-sha',
          GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
          TAG: 'fixture',
        },
      });
      assert.ifError(result.error);
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
      const calls = fs
        .readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      const moves = calls.filter((c) => c.args.some((a) => a.startsWith('--to-revisions=')));
      const active = state.service.status.traffic.filter((t) => t.percent > 0);
      assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stdout + result.stderr);
      assert.equal(active.length, 1);
      assert.equal(active[0].percent, 100);
      assert.equal(
        active[0].revisionName,
        ['success', 'rollback-error'].includes(scenario) ? state.candidate : 'synap-backend-old',
      );
      assert.equal(
        moves.length,
        scenario === 'success'
          ? 1
          : ['live-health', 'live-readiness', 'promotion-error', 'rollback-error'].includes(scenario)
            ? 2
            : 0,
      );
      if (moves.length === 2)
        assert.match(
          result.stderr,
          scenario === 'rollback-error' ? /ROLLBACK NOT VERIFIED/ : /Rollback verified/,
        );
      assert.ok(!state.service.status.traffic.some((t) => t.tag), 'Temporary tag removed');
      if (scenario !== 'test-failure') {
        assert.match(
          fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'),
          /--to-revisions=synap-backend-old=100/,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('configuration preflight rejects a split rollout and missing queue URL', () => {
  const { service, revisions } = fixture();
  service.status.traffic = [
    { revisionName: 'synap-backend-old', percent: 90 },
    { revisionName: 'other', percent: 10 },
  ];
  assert.throws(() => checks.baseline(service), /100% traffic/);
  service.status.traffic = [{ revisionName: 'synap-backend-old', percent: 100 }];
  const revision = revisions['synap-backend-old'];
  revision.spec.containers[0].env = revision.spec.containers[0].env.filter(
    (e) => e.name !== 'SYNAP_SERVICE_URL',
  );
  assert.throws(() => checks.origin(service, revision), /SYNAP_SERVICE_URL/);
});

test('rollback baseline uses the serving revision, even when the latest revision differs', () => {
  const { service, revisions } = fixture();
  service.status.latestCreatedRevisionName = service.status.latestReadyRevisionName =
    'newer-but-rolled-back';
  assert.match(checks.baseline(service), /^synap-backend-old\t/);
  assert.equal(checks.origin(service, revisions['synap-backend-old']), 'old-sha');
});

test('automatic rollback refuses to overwrite a different deployment', () => {
  const { service } = fixture();
  service.status.latestCreatedRevisionName = 'another-deployment';
  assert.throws(
    () => checks.rollbackAllowed(service, 'synap-backend-old', 'our-candidate'),
    /Another deployment/,
  );
});

test('candidate rejects identity, concurrency, probe and secret mount changes', () => {
  const previous = fixture().revisions['synap-backend-old'];
  const candidate = structuredClone(previous);
  candidate.metadata.name = 'candidate';
  candidate.metadata.annotations['run.googleapis.com/cpu-throttling'] = 'true';
  candidate.spec.containers[0].resources.limits.cpu = '1';
  const update = 'SYNAP_SERVICE_URL=https://production.example.test';
  assert.doesNotThrow(() => checks.candidate(previous, candidate, update, 'candidate'));
  for (const mutate of [
    (r) => (r.spec.serviceAccountName = 'different@example.test'),
    (r) => (r.spec.containerConcurrency = 10),
    (r) => (r.metadata.annotations['autoscaling.knative.dev/minScale'] = '5'),
    (r) => (r.spec.containers[0].startupProbe.httpGet.path = '/different'),
    (r) =>
      (r.spec.containers[0].env.find((e) => e.name === 'SECRET_MOUNT').valueFrom.secretKeyRef.key =
        'latest'),
  ]) {
    const changed = structuredClone(candidate);
    mutate(changed);
    assert.throws(
      () => checks.candidate(previous, changed, update, 'candidate'),
      /Candidate changed/,
    );
  }
  assert.throws(
    () => checks.candidate(previous, candidate, 'SYNAP_GEMINI_API_KEY_SECRET=wrong', 'candidate'),
    /Unexpected deployment environment update/,
  );
});
