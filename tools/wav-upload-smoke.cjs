/* Saved WAV -> reload -> exact upload retry, with a 26-second gapped PCM take. */
'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const { createStaticServer, launchChromium } = require('./support/browser-fixture.cjs');
const server = createStaticServer(path.resolve(__dirname, '..'));
setTimeout(() => { console.error('WAV upload test exceeded 120 seconds');process.exit(1); }, 120000).unref();
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = process.env.SYNAP_STORAGE_BROWSER === 'webkit'
    ? await require('playwright').webkit.launchPersistentContext('', { headless: true }) : await launchChromium();
  try {
    const page = await browser.newPage();
    page.on('console', message => console.log('browser:', message.text()));
    page.on('pageerror', error => console.error(error.stack));
    await page.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    await page.route('**/__upload', r => r.fulfill({ contentType: 'text/html', body:
      '<!doctype html><script src="/audio-store.js"></script><script src="/recording/journal.js"></script><script src="/recording/timeline.js"></script><script src="/processing-queue.js"></script><script src="/synap-backend.js"></script>' }));
    await page.goto(origin + '/__upload');
    const id = await page.evaluate(async () => {
      const store = new DKAudioStore(SynapRecordingJournal.options({ transport: true }));
      await store.verifyWritable();
      const id = await store.begin('Upload read fixture');
      for (let sequence = 0; sequence < 520; sequence++) {
        if (sequence === 333) continue;
        const payload = new Uint8Array(1600);new DataView(payload.buffer).setInt16(0, sequence + 1, true);
        store.append(id, { sequence, chunk: 0, total: 1, payload, transport: 'pcm16' });
        if (sequence % 20 === 19) await store.flush();
      }
      console.log('Packets saved');await store.close(id);
      // Exact packet shape from the rejected-Stop report: 399 complete PCM
      // frames plus the first fragment of frame 400 (1,597 packets).
      const partialId=await store.begin('Interrupted Stop');
      for(let sequence=0;sequence<400;sequence++) {
        for(let chunk=0;chunk<(sequence===399?1:4);chunk++) {
          const payload=new Uint8Array(400),view=new DataView(payload.buffer);
          for(let i=0;i<200;i++)view.setInt16(i*2,sequence+1,true);
          store.append(partialId,{sequence,chunk,total:4,payload,transport:'pcm16'});
        }
        if(sequence%20===19)await store.flush();
      }
      await store.close(partialId,'stop-unconfirmed');
      console.log('Recordings sealed');return {id,partialId};
    });
    // Reload requires reading durable IndexedDB rows, not retained JS objects.
    console.log('Reloading saved recording');await page.reload();
    const result = await page.evaluate(async ({id,partialId}) => {
      console.log('Preparing saved upload');const store = new DKAudioStore(), uploads = [];
      globalThis.SynapAuth = {
        isSignedIn: () => true, session: () => ({ profile: { uid: 'fixture' } }),
        async authedFetch(path, init) {
          console.log('Request', path);
          if (path.includes('/segments/')) {
            uploads.push(new Uint8Array(init.body));
            return new Response('{}', { status: uploads.length === 1 ? 503 : 200 });
          }
          return new Response('{}');
        },
      };
      const job = { recordingId: id, segmentIndex: 0, kind: 'transcribe' };
      let error;
      try { await DKFIFOProcessor.provider('synap').process({ store }, job, {}); }
      catch (e) { error = { stage: e.audioStage, status: e.status }; }
      await DKFIFOProcessor.provider('synap').process({ store }, job, {});
      const record = await store.get('recordings', id);
      const source = new Uint8Array(await (await store.blob(record)).arrayBuffer());
      for (const bytes of uploads) {
        if (bytes.length !== source.length || bytes.some((b, i) => b !== source[i])) throw Error('Upload changed source');
      }
      await DKAudioCodec.validateWav(new Blob([source]));
      const partial=await store.get('recordings',partialId);
      const meta=await store.get('segments',[partialId,0]);
      if(!(meta.pcmBuffer instanceof ArrayBuffer)||meta.pcmBlob)throw Error('New audio still depends on a persisted Blob');
      if(partial.stats.completeFrames!==399||partial.stats.incompleteFrames!==1||partial.stats.packetsReceived!==1597)
        throw Error('Incomplete-frame evidence changed');
      if((await store.all('packets','recording',partialId)).length!==1)throw Error('Partial raw packet was discarded');
      await DKFIFOProcessor.provider('synap').process({store},{recordingId:partialId,segmentIndex:0,kind:'transcribe'},{});
      const interrupted=new DataView(uploads[2].buffer);
      if(interrupted.byteLength!==640044)throw Error('Interrupted Stop lost its timeline');
      for(let frame=0;frame<400;frame++)for(let sample=0;sample<800;sample++)
        if(interrupted.getInt16(44+frame*1600+sample*2,true)!==(frame===399?0:frame+1))throw Error('Interrupted Stop changed captured PCM');
      // Existing Blob rows remain readable when full reads fail but bounded
      // slices still work; successful recovery must be byte-for-byte exact.
      const legacy=new Blob([new Uint8Array(meta.pcmBuffer)],{type:'application/octet-stream'});
      await store.atomic(['segments'],s=>s.segments.put({recordingId:'legacy',index:0,pcmBlob:legacy,
        frameCount:399,timelineFrameCount:400,incomplete:1}));
      const arrayBuffer=Blob.prototype.arrayBuffer,readFile=FileReader.prototype.readAsArrayBuffer;
      let failedFullReads=0;
      try {
        Blob.prototype.arrayBuffer=function(){
          if(this.type==='application/octet-stream'){failedFullReads++;return Promise.reject(new Error('Persisted Blob read failed'));}
          return arrayBuffer.call(this);
        };
        FileReader.prototype.readAsArrayBuffer=function(blob){
          if(blob.type==='application/octet-stream'){failedFullReads++;queueMicrotask(()=>this.onerror(new Event('error')));return;}
          return readFile.call(this,blob);
        };
        const recovered=await store.segment('legacy',0),fresh=await store.segment(partialId,0);
        for(const audio of [recovered.blob,fresh.blob]) {
          const bytes=new Uint8Array(await audio.arrayBuffer());
          if(bytes.length!==uploads[2].length||bytes.some((x,i)=>x!==uploads[2][i]))throw Error('Blob recovery changed PCM');
        }
        if(failedFullReads!==2)throw Error('Did not exercise both failed native readers');
      } finally {Blob.prototype.arrayBuffer=arrayBuffer;FileReader.prototype.readAsArrayBuffer=readFile;}
      console.log('Checking FileReader fallback');const nativeRead = Blob.prototype.arrayBuffer;
      try {
        Blob.prototype.arrayBuffer = async () => new ArrayBuffer(0);
        const copy = new Uint8Array(await DKAudioCodec.readBlob(new Blob([source])));
        if (copy.length !== source.length || copy.some((b, i) => b !== source[i])) throw Error('FileReader fallback changed source');
        await DKAudioCodec.validateWav(new Blob([source]));
      } finally { Blob.prototype.arrayBuffer = nativeRead; }
      return { error, count: uploads.length, bytes: source.length, duration: record.durationMs, missing: record.stats.missingFrames };
    }, id);
    assert.deepEqual(result, { error: { stage: 'sending upload', status: 503 }, count: 3, bytes: 832044, duration: 26000, missing: 1 });
    console.log('PASS ' + (process.env.SYNAP_STORAGE_BROWSER || 'chromium') + ' persisted gapped/interrupted PCM, reload, byte-identical upload retry and legacy Blob recovery');
  } finally { await browser.close();server.close(); }
})().catch(e => { console.error(e);server.close();process.exitCode = 1; });
