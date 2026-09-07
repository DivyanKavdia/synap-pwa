import assert from 'node:assert/strict';
import test from 'node:test';
import {
  interactionJson,
  interactionText,
  interactionWords,
  normalize,
  type InteractionResponse,
} from '../src/gemini/client.js';
import { formatMs, toSpeakerLines } from '../src/gemini/transcribe.js';
import { clamp, offsetToMs } from '../src/util/retry.js';
import { fingerprint, localDay, nameKey, normalizeName, topicKey } from '../src/util/ids.js';
import { generateDek } from '../src/crypto/envelope.js';

function response(text: string): InteractionResponse {
  return { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] };
}

test('text is read out of model_output steps', () => {
  assert.equal(interactionText(response('hello')), 'hello');
});

test('non-model steps are ignored when reading text', () => {
  const payload: InteractionResponse = {
    steps: [
      { type: 'thought', content: [{ type: 'text', text: 'internal reasoning' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'answer' }] },
    ],
  };
  assert.equal(interactionText(payload), 'answer');
});

test('word annotations are collected across content items', () => {
  const payload: InteractionResponse = {
    steps: [
      {
        type: 'model_output',
        content: [
          {
            type: 'text',
            text: 'Hello world',
            annotations: [
              { type: 'word_info', text: 'Hello', speaker: 'spk_1', start_offset: '0.100s', end_offset: '0.450s' },
              { type: 'word_info', text: 'world', speaker: 'spk_1', start_offset: '0.500s', end_offset: '0.850s' },
            ],
          },
        ],
      },
    ],
  };
  const words = interactionWords(payload);
  assert.equal(words.length, 2);
  assert.equal(words[1]?.speaker, 'spk_1');
});

test('structured output parses plain JSON', () => {
  assert.deepEqual(interactionJson(response('{"a":1}')), { a: 1 });
});

test('structured output survives a fenced JSON block', () => {
  assert.deepEqual(interactionJson(response('```json\n{"a":1}\n```')), { a: 1 });
});

test('empty model output raises rather than returning a hollow object', () => {
  assert.throws(() => interactionJson(response('')), /no text content/);
});

test('gemini duration strings convert to milliseconds', () => {
  assert.equal(offsetToMs('1.250s'), 1250);
  assert.equal(offsetToMs('0.100s'), 100);
  assert.equal(offsetToMs(undefined), 0);
  assert.equal(offsetToMs('garbage'), 0);
});

test('embeddings are unit length so cosine distance behaves', () => {
  const unit = normalize([3, 4]);
  const magnitude = Math.hypot(...unit);
  assert.ok(Math.abs(magnitude - 1) < 1e-9);
});

test('normalizing a zero vector does not produce NaN', () => {
  assert.deepEqual(normalize([0, 0]), [0, 0]);
});

test('diarized words become speaker-attributed lines', () => {
  const lines = toSpeakerLines(
    [
      { text: 'We', speaker: 'S1', start_ms: 0, end_ms: 200 },
      { text: 'ship', speaker: 'S1', start_ms: 200, end_ms: 400 },
      { text: 'Friday?', speaker: 'S2', start_ms: 500, end_ms: 900 },
    ],
    'We ship Friday?',
  );
  assert.equal(lines, '[00:00] S1: We ship\n[00:00] S2: Friday?');
});

test('partial word annotations never truncate a complete flat transcript', () => {
  const flat = 'This is the complete transcript and it continues for much longer than the timed words.';
  const rendered = toSpeakerLines(
    [
      { text: 'This', speaker: 'S1', start_ms: 0, end_ms: 150 },
      { text: 'is', speaker: 'S1', start_ms: 150, end_ms: 250 },
      { text: 'the', speaker: 'S1', start_ms: 250, end_ms: 350 },
    ],
    flat,
  );
  assert.equal(rendered, flat);
});

test('complete word annotations may differ only by punctuation and spacing', () => {
  const rendered = toSpeakerLines(
    [
      { text: 'Hello', speaker: 'S1', start_ms: 0, end_ms: 200 },
      { text: 'world', speaker: 'S1', start_ms: 200, end_ms: 400 },
    ],
    'Hello, world!',
  );
  assert.equal(rendered, '[00:00] S1: Hello world');
});

test('no diarization falls back to the flat transcript', () => {
  assert.equal(toSpeakerLines([], 'flat text'), 'flat text');
});

test('timestamps format with an hour component only when needed', () => {
  assert.equal(formatMs(65_000), '01:05');
  assert.equal(formatMs(3_665_000), '01:01:05');
});

test('clamp keeps model-reported offsets inside the recording', () => {
  assert.equal(clamp(-5, 0, 100), 0);
  assert.equal(clamp(500, 0, 100), 100);
  assert.equal(clamp(Number.NaN, 0, 100), 0);
});

test('name normalization folds case, accents and punctuation', () => {
  assert.equal(normalizeName('  Ánkit  Sharma! '), 'ankit sharma');
});

test('the same name under one key is stable, and differs across users', () => {
  const mine = generateDek();
  const theirs = generateDek();
  assert.equal(nameKey(mine, 'Ankit'), nameKey(mine, ' ankit '));
  assert.notEqual(nameKey(mine, 'Ankit'), nameKey(theirs, 'Ankit'));
});

test('the name key does not leak the name', () => {
  const key = nameKey(generateDek(), 'Ankit');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes('ankit'));
});

test('topic keys are slugs safe for array-contains filters', () => {
  assert.equal(topicKey('Project Falcon'), 'project-falcon');
});

test('a local day respects the zone rather than UTC', () => {
  // 19:00 UTC is already the next calendar day in Kolkata (UTC+5:30).
  assert.equal(localDay('2026-09-04T19:00:00Z', 'Asia/Kolkata'), '2026-09-05');
  assert.equal(localDay('2026-09-04T10:00:00Z', 'Asia/Kolkata'), '2026-09-04');
});

test('an unknown timezone degrades to UTC instead of throwing', () => {
  assert.equal(localDay('2026-09-04T10:00:00Z', 'Not/AZone'), '2026-09-04');
});

test('fingerprints are stable for equal bodies and differ otherwise', () => {
  assert.equal(fingerprint({ a: 1 }), fingerprint({ a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});
