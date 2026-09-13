const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

function source(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

require('../audio-store.js');

test('rolling windows seal only complete audio and publish readiness after persistence', async () => {
  const calls = [], store = new DKAudioStore({rolling:true,onWindowReady:()=>calls.push('ready')});
  let packets = Array.from({length:599},(_,sequence)=>({sequence,chunk:0,total:1,payload:new Uint8Array(1600)}));
  store.flush = async () => {};
  store.get = async () => null;
  store.all = async () => packets;
  store.compactSegment = async () => { await Promise.resolve(); calls.push('committed'); return true; };
  store.sealWindow('take',0); await store.flushWindows();
  assert.deepEqual(calls, [], 'a missing frame remains recoverable');
  packets.push({sequence:599,chunk:0,total:1,payload:new Uint8Array(1600)});
  store.sealWindow('take',0); await store.flushWindows();
  assert.deepEqual(calls, ['committed','ready']);
});

test('capture configuration starts the public processing queue only when authenticated', async () => {
  const vm = require('node:vm'), events = []; let resumes = 0, signedIn = false;
  const context = {localStorage:{getItem:()=>null},SynapAuth:{isSignedIn:()=>signedIn},
    SynapProcessingQueue:{resume:()=>{resumes++;return Promise.resolve()}},
    CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail}},dispatchEvent:e=>events.push(e)};
  vm.createContext(context);vm.runInContext(source('recording/journal.js'),context);
  const options = context.SynapRecordingJournal.options();
  options.onWindowReady({recordingId:'take',segmentIndex:0});
  assert.equal(resumes,0); signedIn=true;
  options.onWindowReady({recordingId:'take',segmentIndex:1});
  assert.equal(resumes,1); assert.equal(events.length,2);
});

test('backend upload performs idempotent rolling transcription', () => {
  const route = source('backend/src/http/routes/recordings.ts');
  const worker = source('backend/src/pipeline/rolling-transcription.ts');
  assert.match(route, /transcribeUploadedWindow/);
  assert.match(route, /transcript_ready/);
  assert.match(route, /existing\.sealedTranscript/);
  assert.match(worker, /hasTranscription\(segment\)/);
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
