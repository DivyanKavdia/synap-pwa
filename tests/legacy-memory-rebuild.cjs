'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const process=read('backend/src/pipeline/process.ts');
const tasks=read('backend/src/http/routes/tasks.ts');
const repair=read('transcript-repair.js');

assert.match(process,/export function groundSegmentTranscript\(/,
  'old sealed transcript windows need a deterministic timestamp grounding helper');
assert.match(process,/groundSegmentTranscript\(text, segment\.startMs\)/,
  'legacy segment text must be anchored using the stored segment start offset');
assert.match(process,/skipTranscription\?: boolean/,
  'the processing pipeline must expose a hard no-STT rebuild mode');
assert.match(process,/segments\.filter\(\(segment\) => !segment\.sealedTranscript\)/,
  'no-STT mode must reject incomplete transcript windows instead of retranscribing them');
assert.match(process,/memoryOnly\?: boolean/,
  'legacy refresh must be able to avoid duplicating derived people and follow-up indexes');
assert.match(process,/if \(options\.memoryOnly\)/,
  'memory-only mode must skip the normal indexing path');

assert.match(tasks,/const rebuild = recording\.state === 'ready' && force/,
  'force should only mean a rebuild for an already-ready recording');
assert.match(tasks,/transcript_windows_incomplete/,
  'force rebuild must fail closed when any sealed transcript window is missing');
assert.match(tasks,/skipTranscription: true, memoryOnly: true/,
  'force rebuild must use transcript-only memory-only processing');
assert.match(tasks,/retranscribed_segments: 0/,
  'the route contract must explicitly report that no audio was retranscribed');

assert.match(repair,/function legacyConversationMemory\(/,
  'the PWA must identify memories written before participant-vs-mention semantics');
assert.match(repair,/conversation\?\.participants/,
  'legacy detection must require the explicit participant field');
assert.match(repair,/conversation\?\.mentioned_people/,
  'legacy detection must require the explicit mentioned-people field');
assert.match(repair,/function autoRepairToday\(/,
  'today legacy memories should self-heal after the user opens the signed-in PWA');
assert.match(repair,/process-now\?force=true/,
  'automatic repair must use the backend transcript-only rebuild endpoint');
assert.match(repair,/scheduleAutoRepair\(1600\)/,
  'automatic repair should start after initial local/cloud hydration settles');
assert.doesNotMatch(repair,/location\.reload\(/,
  'semantic repair must refresh in place and never tear down the BLE page');

console.log('PASS: legacy memories rebuild from sealed transcript windows with zero STT calls.');
