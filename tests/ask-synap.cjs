'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Ask Synap uses authenticated grounded backend retrieval when signed in', () => {
  const client = read('ask-synap.js');
  const route = read('backend/src/http/routes/brain.ts');
  const answerer = read('backend/src/gemini/ask.ts');

  assert.match(client, /const ASK_ENDPOINT = '\/v1\/ask'/);
  assert.match(client, /SynapAuth\.isSignedIn/);
  assert.match(client, /SynapAuth\.authedFetch\(ASK_ENDPOINT/);
  assert.match(client, /method: 'POST'/);
  assert.match(client, /JSON\.stringify\(\{ query: clean, max_sources: MAX_SOURCES \}\)/);
  assert.match(client, /event\.stopImmediatePropagation\(\)/,
    'cloud Ask must prevent the old local keyword handler from also answering');
  assert.match(client, /if \(!form \|\| form\.id !== 'askForm' \|\| !cloudReady\(\)\) return/,
    'offline or signed-out mode leaves the existing local matcher available');
  assert.match(client, /source\.recording_id/);
  assert.match(client, /source\.quote/);
  assert.match(client, /result\.confidence/);

  assert.match(route, /router\.post\(\s*'\/ask'/s);
  assert.match(route, /embedContent\(query, 'RETRIEVAL_QUERY'\)/);
  assert.match(route, /findNearestConversations/);
  assert.match(route, /answerFromEvidence\(query, evidence\)/);
  assert.match(route, /searched:/);

  assert.match(answerer, /Use only the evidence/);
  assert.match(answerer, /source_indices/);
  assert.match(answerer, /return NOT_FOUND/);
});
