const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

function source(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

test('one logical recording uses 30-second processing windows', () => {
  const audio = source('audio-store.js');
  const rolling = source('battery-popover-fix.js');
  assert.match(audio, /const SEGMENT_FRAMES = 600/);
  assert.match(audio, /async blob\(record\)/);
  assert.match(audio, /const segments=\(await this\.all\('segments','recording',record\.id\)\)/);
  assert.match(rolling, /WINDOW_FRAMES=600/);
  assert.match(rolling, /originalClose\.call\(this,recordingId,reason\)/);
  assert.doesNotMatch(rolling, /sourceFileSeconds|sourceFileCount|ONE_MINUTE_FRAMES/);
});

test('completed processing windows are sealed and the real processor is woken during capture', () => {
  const rolling = source('battery-popover-fix.js');
  assert.match(rolling, /sealWindow\(this,recordingId,previous\)/);
  assert.match(rolling, /compactSegment\(recordingId,index,data\)/);
  assert.match(rolling, /__synapProcessingInstance/);
  assert.match(rolling, /processor\.resume\(\)/);
  assert.match(rolling, /synap-transcription-window-ready/);
  assert.match(rolling, /class SynapRollingProcessor extends Base/);
});

test('rolling transcription does not depend on the UI processing button', () => {
  const rolling = source('battery-popover-fix.js');
  const app = source('app.js');
  assert.match(app, /recordingConfirmed \|\| finalizing/,
    'the manual processing control remains intentionally blocked while recording');
  assert.match(rolling, /const processor=root\[PROCESSOR_SLOT\]/);
  assert.match(rolling, /processor&&typeof processor\.resume==='function'/);
});

test('backend upload performs idempotent rolling transcription', () => {
  const route = source('backend/src/http/routes/recordings.ts');
  const worker = source('backend/src/pipeline/rolling-transcription.ts');
  assert.match(route, /transcribeUploadedWindow/);
  assert.match(route, /transcript_ready/);
  assert.match(route, /existing\.sealedTranscript/);
  assert.match(worker, /if \(segment\.sealedTranscript && segment\.sealedWords && segment\.state === 'transcribed'\) return segment/);
  assert.match(worker, /diarize: true/);
  assert.match(worker, /wordTimestamps: true/);
});

test('final memory response includes the complete combined transcript', () => {
  const route = source('backend/src/http/routes/recordings.ts');
  const pipeline = source('backend/src/pipeline/process.ts');
  assert.match(route, /recording\.sealedTranscript/);
  assert.match(route, /transcript,/);
  assert.match(pipeline, /grounded = toSpeakerLines\(words, grounded\)/);
  assert.match(pipeline, /let transcript = flat\.join\('\\n'\)/);
  assert.match(pipeline, /sealedTranscript: sealText/);
});
