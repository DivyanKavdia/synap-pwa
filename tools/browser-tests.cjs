'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// CI and local development run this same sequence. Individual scripts also run alone.
const suites = [
  ['workflow', { SYNAP_WORKFLOW_OUTPUT: 'artifacts/workflows' }],
  ['ui', { SYNAP_UI_OUTPUT: 'artifacts/workflows/ui' }],
  ['transcript', { SYNAP_TRANSCRIPT_OUTPUT: 'artifacts/workflows/transcripts' }],
  ['processing'],
  ['controls'],
  ['recording-notifications'],
  ['connection'],
  ['connection', { SYNAP_RECOVERY_FIXTURE: '1' }],
  ['meeting-features'],
  ['firmware-progress', { SYNAP_FIRMWARE_OUTPUT: 'artifacts/workflows/firmware' }],
  ['audio-enhancement'],
  ['settings', { SYNAP_SETTINGS_OUTPUT: 'artifacts/workflows/settings' }],
  ['library-selection', { SYNAP_LIBRARY_OUTPUT: 'artifacts/workflows/library' }],
  ['actions', { SYNAP_ACTIONS_OUTPUT: 'artifacts/workflows/actions' }],
  ['actions-functional'],
  ['memory-workspace'],
  ['speaker-names', { SYNAP_SPEAKERS_OUTPUT: 'artifacts/workflows/speakers' }],
];
const selected = process.argv.slice(2);
if (selected.some((name) => !suites.some(([suite]) => suite === name))) {
  console.error(
    'Unknown suite. Choose from: ' + [...new Set(suites.map(([name]) => name))].join(', '),
  );
  process.exit(1);
}
for (const [name, env] of suites) {
  if (selected.length && !selected.includes(name)) continue;
  console.log(`Running ${name}${env?.SYNAP_RECOVERY_FIXTURE ? ' (buffered recovery)' : ''}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, `${name}-smoke.cjs`)], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
