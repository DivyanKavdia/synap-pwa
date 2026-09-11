import assert from 'node:assert/strict';
import test from 'node:test';
import { RecordingSpeakers, labelWords } from '../src/speaker/diarization.js';
import { extractSpeakerSample, makePcm16Wav } from '../src/speaker/audio.js';
import { toSpeakerLines } from '../src/gemini/transcribe.js';
import type { TranscriptWord } from '../src/store/types.js';

const words = (speaker='spk_1'): TranscriptWord[] => [{text:'Hello',speaker,start_ms:0,end_ms:1000}];
test('reused ASR labels stay distinct across requests without acoustic evidence',async()=>{
  const ids=new RecordingSpeakers();
  assert.equal((await ids.mapWindow(0,words())).spk_1,'S1.1');
  assert.equal((await ids.mapWindow(1,words())).spk_1,'S2.1');
  assert.equal((await ids.mapWindow(2,words(),async()=>{throw new Error('unavailable')})).spk_1,'S3.1');
});
test('matching voices can link swapped local labels but two voices in one window never collapse',async()=>{
  const ids=new RecordingSpeakers();
  await ids.mapWindow(0,[...words('a'),...words('b')],async s=>({model:'m',embedding:s==='a'?[1,0,0]:[0,1,0]}));
  const mapped=await ids.mapWindow(1,[...words('a'),...words('b')],async s=>({model:'m',embedding:s==='b'?[1,0,0]:[0,1,0]}));
  assert.equal(mapped.a,'S1.2');assert.equal(mapped.b,'S1.1');
  const ambiguous=await ids.mapWindow(2,[...words('a'),...words('b')],async()=>({model:'m',embedding:[1,0,0]}));
  assert.notEqual(ambiguous.a,ambiguous.b);
  const otherModel=await ids.mapWindow(3,words(),async()=>({model:'other',embedding:[1,0,0]}));
  assert.equal(otherModel.spk_1,'S4.1');
});
test('uncertain acoustic matches do not invent a shared speaker',async()=>{
  const ids=new RecordingSpeakers(.8,.1);
  await ids.mapWindow(0,[...words('a'),...words('b')],async s=>({model:'m',embedding:s==='a'?[1,0]:[.95,.31]}));
  const map=await ids.mapWindow(1,words(),async()=>({model:'m',embedding:[.99,.1]}));
  assert.equal(map.spk_1,'S2.1');
  assert.deepEqual(labelWords(words('YOU'),map),words('YOU'));
});
test('a partial window keeps all text without erasing labels in complete windows',async()=>{
  const ids=new RecordingSpeakers();
  const first=toSpeakerLines(labelWords(words(),await ids.mapWindow(0,words())), '[00:00] S?: Hello');
  const second=toSpeakerLines([{text:'Only',speaker:'spk_1',start_ms:30000,end_ms:31000}], '[00:30] S?: Only some words have annotations.');
  assert.equal([first,second].join('\n'),'[00:00] S1.1: Hello\n[00:30] S?: Only some words have annotations.');
});
test('overlapping voices are excluded from speaker identity samples',()=>{
  const audio=makePcm16Wav(Buffer.alloc(16000*2*5));
  const mixed=[{text:'one',speaker:'a',start_ms:0,end_ms:4000},{text:'two',speaker:'b',start_ms:0,end_ms:4000}];
  assert.equal(extractSpeakerSample(audio,mixed,'a',0,2500,8000),null);
});
