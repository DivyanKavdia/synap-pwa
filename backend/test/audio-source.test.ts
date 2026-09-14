import assert from 'node:assert/strict';
import test from 'node:test';
import { transcribeSegment } from '../src/gemini/transcribe.js';
import { makePcm16Wav } from '../src/speaker/audio.js';

test('ASR receives every source byte including digital silence, quiet samples and original window offsets', async () => {
  for (const quiet of [false, true]) {
    const pcm = Buffer.alloc(160000);
    if (quiet) for (let i = 32000; i < 48000; i++) pcm.writeInt16LE(i % 2 ? 1 : -2, i * 2);
    const audio = makePcm16Wav(pcm), before = Buffer.from(audio), original = fetch;
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.input[0].mime_type, 'audio/wav');
      assert.deepEqual(Buffer.from(body.input[0].data, 'base64'), before);
      assert.equal(body.store, false);
      return new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{
        type: 'text', text: quiet ? 'Quiet' : '', annotations: quiet ? [{type:'word_info',text:'Quiet',speaker:'spk_1',start_offset:'2s',end_offset:'3s'}] : [],
      }] }] }));
    };
    try {
      const result = await transcribeSegment(audio, 'audio/wav', { baseOffsetMs: 30000 });
      assert.equal(calls, quiet ? 1 : 0, 'only an entirely zero source may skip ASR');
      assert.deepEqual(audio, before);
      if (quiet) assert.equal(result.words[0]?.start_ms, 32000);
      else assert.equal(result.text, '');
    } finally { globalThis.fetch = original; }
  }
});
