'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

const config = read('backend/src/config.ts');
const memory = read('backend/src/gemini/memory.ts');
const ask = read('backend/src/gemini/ask.ts');
const brief = read('backend/src/pipeline/brief.ts');
const deploy = read('infra/deploy.sh');
const account = read('synap-account-ui.js');

assert.match(config, /gemini-3\.5-transcribe/);
assert.match(config, /memoryModel:[\s\S]*gemini-3\.5-flash['"]/);
assert.match(config, /queryModel:[\s\S]*gemini-3\.5-flash['"]/);
assert.match(config, /gemini-3\.8-flash/);
assert.doesNotMatch(config, /memoryModel:[\s\S]{0,160}gemini-3\.5-flash-lite/);
assert.match(memory, /usage_label: 'memory_extract'[\s\S]*|thinking_level: 'medium'/);
assert.match(memory, /thinking_level: 'medium'/);
assert.match(ask, /model: config\.gemini\.queryModel[\s\S]*thinking_level: 'low'/);
assert.match(ask, /model: config\.gemini\.askModel[\s\S]*thinking_level: 'low'/);

// Rebuilding a day must not invoke Gemini; otherwise every new recording resends
// all earlier memories and token spend grows approximately quadratically.
assert.doesNotMatch(brief, /generateBrief\s*\(/);
assert.match(brief, /const brief = fallbackBrief\(memories\)/);

// CI deploys must pin the same quality-first routing as application defaults.
assert.match(deploy, /SYNAP_GEMINI_STT_MODEL/);
assert.match(deploy, /memory_model="\$\{SYNAP_GEMINI_MEMORY_MODEL:-gemini-3\.5-flash\}"/);
assert.match(deploy, /query_model="\$\{SYNAP_GEMINI_QUERY_MODEL:-gemini-3\.5-flash\}"/);
assert.match(deploy, /SYNAP_GEMINI_ASK_MODEL/);

// An old browser preference must not silently activate direct OpenAI billing.
assert.match(account, /stored === 'openai'/);
assert.match(account, /savePrefs\(\{ provider: stored \}\)/);

console.log('quality and cost controls: ok');
