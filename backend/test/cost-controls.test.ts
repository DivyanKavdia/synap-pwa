import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { usageLogFields } from '../src/gemini/client.js';

test('Synap keeps dedicated ASR and quality-first reasoning models', () => {
  assert.equal(config.gemini.transcribeModel, 'gemini-3.5-transcribe');
  assert.equal(config.gemini.memoryModel, 'gemini-3.5-flash');
  assert.equal(config.gemini.queryModel, 'gemini-3.5-flash');
  assert.equal(config.gemini.askModel, 'gemini-3.8-flash');
  assert.equal(config.gemini.embedModel, 'gemini-embedding-001');
});

test('usage telemetry contains only numeric counters plus model and stage', () => {
  const fields = usageLogFields('gemini-3.5-flash', 'memory_extract', {
    input_tokens: 1200,
    output_tokens: 180,
    thinking_tokens: 25,
  });

  assert.deepEqual(fields, {
    model: 'gemini-3.5-flash',
    stage: 'memory_extract',
    usage_input_tokens: 1200,
    usage_output_tokens: 180,
    usage_thinking_tokens: 25,
  });
});

test('usage telemetry ignores non-numeric provider metadata', () => {
  const usage = {
    input_tokens: 10,
    provider_note: 'do-not-log-me' as unknown as number,
  };
  const fields = usageLogFields('model', 'stage', usage);
  assert.equal(fields?.usage_input_tokens, 10);
  assert.ok(!Object.hasOwn(fields ?? {}, 'usage_provider_note'));
});
