/* Real IndexedDB and production window/sequence code, using generated PCM only. */
'use strict';
const assert = require('node:assert/strict');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(require('node:path').resolve(__dirname, '..'));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.route('**/__storage', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><title>Audio storage fixture</title><header></header><script src="/audio-codec-v3.js"></script><script src="/audio-store.js"></script><script src="/recording/journal.js"></script><script src="/recording/timeline.js"></script><script src="/audio-quality.js"></script><script src="/synap-backend.js"></script>' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/__storage');
    const result = await page.evaluate(async () => {
      function frame(sequence) {
        const payload = new Uint8Array(1600), view = new DataView(payload.buffer);
        for (let at = 0; at < 1600; at += 2) view.setInt16(at, sequence + 1, true);
        return { sequence, chunk: 0, total: 1, payload, transport: 'pcm16' };
      }
      function append(store, id, from, to) {
        for (let sequence = from; sequence <= to; sequence++) store.append(id, frame(sequence));
      }
      async function settle(store) {
        await store.flush();
        await store.flushWindows();
        await store.flush();
      }
      // Production codec -> notification views -> IndexedDB -> WAV -> native
      // browser decoder. Include the write probe that stores a temporary byte.
      const voice = new DKAudioStore({ name: 'pcm-alignment' });
      await voice.verifyWritable();
      const voiceId = await voice.begin('Generated voice waveform');
      const expected = new Int16Array(384 * 800);
      for (let sequence = 0; sequence < 384; sequence++) {
        const samples = new Int16Array(800);
        for (let i = 0; i < 800; i++) samples[i] = Math.round(1000 * Math.sin((sequence * 800 + i) / 11));
        const encoded = SynapAudioCodecV3.encodeFrame(samples);
        const decoded = SynapAudioCodecV3.decodeFrame(encoded);
        expected.set(new Int16Array(decoded.buffer), sequence * 800);
        const packet = new DataView(new ArrayBuffer(429), 17, 412);
        packet.setUint8(0, 0xa5); packet.setUint8(1, 3);
        packet.setUint16(2, sequence, true); packet.setUint8(4, 0); packet.setUint8(5, 1);
        packet.setUint16(6, encoded.length, true);
        new Uint8Array(packet.buffer, packet.byteOffset + 8).set(encoded);
        for (const value of SynapAudioCodecV3.normalizePacket(packet, 'voice')) {
          voice.append(voiceId, { sequence, chunk: value.getUint8(4), total: value.getUint8(5),
            payload: new Uint8Array(value.buffer, value.byteOffset + 8, value.getUint16(6, true)) });
        }
      }
      await voice.verifyWritable();
      const voiceRecording = await voice.close(voiceId);
      const voiceWav = await voice.blob(voiceRecording);
      await DKAudioCodec.validateWav(voiceWav);
      const playback = await new OfflineAudioContext(1, expected.length, 16000).decodeAudioData(await voiceWav.arrayBuffer());
      const audible = playback.getChannelData(0);
      let maxError = 0;
      for (let i = 0; i < expected.length; i++) maxError = Math.max(maxError, Math.min(Math.abs(audible[i] - expected[i] / 32768), Math.abs(audible[i] - expected[i] / (expected[i] < 0 ? 32768 : 32767))));
      const aligned = { bytes: voiceWav.size, samples: playback.length, rate: playback.sampleRate,
        channels: playback.numberOfChannels, maxError, recordings: (await voice.all('recordings')).length,
        segments: (await voice.all('segments')).length };
      // Uncompressed notifications at the supported packet budgets must reach
      // IndexedDB, source WAV, upload selection and native playback unchanged.
      for (const payloadBytes of [160,230,400]) {
        const raw = new DKAudioStore({name:'raw-'+payloadBytes});
        const rawId = await raw.begin('Uncompressed fixture');
        const source = new Int16Array(84*800);
        for(let sequence=0;sequence<84;sequence++) {
          const samples=source.subarray(sequence*800,(sequence+1)*800);
          for(let i=0;i<800;i++)samples[i]=sequence===0?(i%2?1:-2):sequence===1?0:((sequence-2)*800+i)%65536-32768;
          const bytes=new Uint8Array(samples.buffer,samples.byteOffset,1600),total=Math.ceil(1600/payloadBytes);
          for(let chunk=total-1;chunk>=0;chunk--) {
            const payload=bytes.subarray(chunk*payloadBytes,(chunk+1)*payloadBytes);
            const value=new DataView(new ArrayBuffer(payload.length+19),11,payload.length+8);
            value.setUint8(0,0xa5);value.setUint8(1,2);value.setUint16(2,sequence,true);
            value.setUint8(4,chunk);value.setUint8(5,total);value.setUint16(6,payload.length,true);
            new Uint8Array(value.buffer,value.byteOffset+8,payload.length).set(payload);
            for(const packet of SynapAudioCodecV3.normalizePacket(value,'raw')) raw.append(rawId,{sequence,
              chunk:packet.getUint8(4),total:packet.getUint8(5),transport:'pcm16',
              payload:new Uint8Array(packet.buffer,packet.byteOffset+8,packet.getUint16(6,true))});
          }
          if(sequence%20===19)await raw.flush();
        }
        const saved=await raw.close(rawId),wav=await raw.blob(saved);
        const expected=new Uint8Array(source.buffer),body=new Uint8Array(await wav.arrayBuffer());
        if(body.length!==44+expected.length||expected.some((x,i)=>x!==body[i+44]))throw Error('PCM bytes changed in storage');
        if(saved.stats.transportFrames.pcm16!==84)throw Error('PCM provenance was lost');
        globalThis.SynapAudioEnhancement={prepareForUpload:()=>{throw Error('Upload must not enhance source')}};
        const selected=await SynapBackend.transcriptionAudio(raw,{recordingId:rawId,segmentIndex:0},wav);
        const uploaded=new Uint8Array(await selected.arrayBuffer());
        if(uploaded.some((x,i)=>x!==body[i]))throw Error('Upload changed PCM');
        const decoded=await new OfflineAudioContext(1,source.length,16000).decodeAudioData(await selected.arrayBuffer());
        // Browser decoders may normalize positive PCM with 32767 or 32768.
        // The stored/uploaded bytes above must be exact; float playback may use
        // either full-scale convention, with only Float32 rounding allowed.
        const output=decoded.getChannelData(0),different=output.findIndex((x,i)=>
          Math.min(Math.abs(x-source[i]/32768),Math.abs(x-source[i]/(source[i]<0?32768:32767)))>1e-7);
        if(decoded.length!==source.length||different>=0)throw Error('PCM playback changed samples');
      }
      const store = new DKAudioStore({ ...SynapRecordingJournal.options({transport:true}), name: 'replayed-frames' });
      const id = await store.begin('Recovered window');
      append(store, id, 0, 97);
      append(store, id, 820, 980);
      await settle(store);
      const before = {
        compacted: Boolean((await store.get('segments', [id, 0]))?.pcmBlob),
        packets: (await store.all('packets', 'segment', [id, 0])).length,
        jobs: (await store.all('jobs')).filter(job => job.segmentIndex === 0).length,
      };
      append(store, id, 98, 599);
      await settle(store);
      const after = {
        compacted: Boolean((await store.get('segments', [id, 0]))?.pcmBlob),
        liveWindow: store.rollingIndex.get(id),
      };
      append(store, id, 600, 819);
      const recovered = await store.close(id);
      const wav = new DataView(await (await store.blob(recovered)).arrayBuffer());
      let exact = wav.byteLength === 44 + 981 * 1600;
      for (let sequence = 0; sequence < 981; sequence++) {
        for (let sample = 0; sample < 800; sample++) {
          if (wav.getInt16(44 + sequence * 1600 + sample * 2, true) !== sequence + 1) exact = false;
        }
      }

      // The same gap without recovered packets stays visible in duration and UI.
      const gaps = new DKAudioStore(SynapRecordingJournal.options({transport:true}));
      const gapId = await gaps.begin('Audio gap fixture');
      append(gaps, gapId, 0, 97);
      append(gaps, gapId, 820, 980);
      await settle(gaps);
      const gapRecording = await gaps.close(gapId);
      const gapWav = new DataView(await (await gaps.blob(gapRecording)).arrayBuffer());
      let zeroFrames = 0;
      for (let sequence = 0; sequence < 981; sequence++) {
        let zero = true;
        for (let sample = 0; sample < 800; sample++) {
          if (gapWav.getInt16(44 + sequence * 1600 + sample * 2, true) !== 0) zero = false;
        }
        if (zero) zeroFrames++;
      }

      const emptyWindow = new DKAudioStore({ ...SynapRecordingJournal.options({transport:true}), name: 'entire-missing-window' });
      const emptyId = await emptyWindow.begin('Missing whole window');
      append(emptyWindow, emptyId, 0, 10);
      append(emptyWindow, emptyId, 1200, 1209);
      await settle(emptyWindow);
      await emptyWindow.close(emptyId);
      const uploadWindows = (await emptyWindow.all('jobs')).filter(job => job.kind === 'transcribe').map(job => job.segmentIndex).sort();

      const partial = new DKAudioStore({ ...SynapRecordingJournal.options({transport:true}), name: 'partial-audio-evidence' });
      const partialId = await partial.begin('Partial frame');
      partial.append(partialId, { sequence: 0, chunk: 0, total: 2, payload: new Uint8Array(800).fill(17) });
      const partialRecording = await partial.close(partialId);

      const signalId = await gaps.begin('Near-silent signal fixture');
      const signalEvents = [];
      addEventListener('synap-audio-signal', event => signalEvents.push(event.detail.nearSilent));
      SynapAudioQuality.reset();
      const realNow = Date.now;
      let clock = realNow();
      Date.now = () => clock;
      let liveSignal;
      try {
        for (let sequence = 0; sequence < 124; sequence++) {
          const pcm = new Int16Array(800);
          for (let i = 0; i < 800; i++) pcm[i] = sequence < 4 ? (i % 2 ? -32768 : 32767) : (i % 5 < 2 ? -1 : 0);
          const payload = new Uint8Array(pcm.buffer);
          clock += 50;
          SynapAudioQuality.observe(payload);
          gaps.append(signalId, { sequence, chunk: 0, total: 1, payload });
        }
        liveSignal = document.getElementById('recordingQuality').textContent;
      } finally { Date.now = realNow; }
      const signalRecording = await gaps.close(signalId);
      await gaps.atomic(['recordings'], s => s.recordings.put({ ...signalRecording, audioQuality: SynapAudioQuality.snapshot() }));
      return {
        aligned,
        signalId, liveSignal, signalEvents,
        before, after, recovered: { stats: recovered.stats, durationMs: recovered.durationMs, exact },
        gap: { id: gapId, stats: gapRecording.stats, durationMs: gapRecording.durationMs, zeroFrames,
          notice: SynapAudioQuality.gaps(gapRecording.stats, gapRecording.durationMs) },
        uploadWindows,
        partial: { status: partialRecording.status, packets: (await partial.all('packets')).length, jobs: (await partial.all('jobs')).length },
      };
    });
    assert.deepEqual(result.aligned, { bytes: 614444, samples: 307200, rate: 16000,
      channels: 1, maxError: result.aligned.maxError, recordings: 1, segments: 1 }, 'browser playback retains every decoded sample with no leading probe byte');
    assert(result.aligned.maxError < 1e-7, 'playback differs only by Float32 rounding');
    assert.deepEqual(result.before, { compacted: false, packets: 98, jobs: 0 });
    assert.deepEqual(result.after, { compacted: true, liveWindow: 1 });
    assert.equal(result.recovered.stats.completeFrames, 981);
    assert.equal(result.recovered.stats.missingFrames, 0);
    assert.equal(result.recovered.durationMs, 49050);
    assert.equal(result.recovered.exact, true, 'every recovered sample retains its original position');
    assert.equal(result.gap.zeroFrames, 722);
    assert.equal(result.gap.stats.missingFrames, 722);
    assert.equal(result.gap.durationMs, 49050);
    assert.equal(result.gap.notice.label, '36.1 s missing (74%)');
    assert.deepEqual(result.uploadWindows, [0, 1, 2], 'silent timeline windows must not strand backend finalization');
    assert.deepEqual(result.partial, { status: 'empty', packets: 1, jobs: 0 });
    assert.match(result.liveSignal, /Almost no microphone signal/);
    assert.deepEqual(result.signalEvents, [true], 'the diagnostic event is emitted once for the sustained flat signal');

    await page.goto(origin + '/');
    await page.waitForFunction(() => document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'));
    await page.locator('.brain-tabs a[href="#library"]').click();
    const card = page.locator('#recording-' + result.gap.id);
    await card.waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await card.locator('.recording-row-meta').textContent(), /Audio incomplete: 36\.1 s missing \(74%\)/);
    await card.locator('summary').first().click();
    await card.locator('.recording-audio-gap').waitFor({ state: 'visible' });
    assert.match(await card.locator('.recording-audio-gap').textContent(), /cannot restore missing speech/);
    assert.match(await card.locator('.recording-transport-detail').textContent(), /Uncompressed audio/);
    const signalCard = page.locator('#recording-' + result.signalId);
    assert.match(await signalCard.locator('.recording-row-meta').textContent(), /Microphone signal was nearly silent/);
    await signalCard.locator('summary').first().click();
    assert.match(await signalCard.locator('.recording-signal-warning').textContent(), /Almost no microphone signal for 6 s during/);
    assert.deepEqual(errors, []);
    console.log('PASS audio integrity: late replay restores exact PCM; missing windows stay visible and uploadable; partial packets remain stored');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
