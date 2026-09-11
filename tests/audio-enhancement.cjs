'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {Worker}=require('node:worker_threads'),crypto=require('node:crypto');
const {wav,fixture,pcm,rms}=require('../tools/audio-enhancement-fixtures.cjs');
const root=path.join(__dirname,'..');
// Adapt the browser module boundary only. The pinned JS/WASM model and DSP code execute unchanged.
const workerAdapter=`
const {parentPort}=require('node:worker_threads'),fs=require('node:fs'),vm=require('node:vm');
globalThis.self=globalThis;
globalThis.postMessage=(message,transfer)=>parentPort.postMessage(message,transfer);
const vendor=fs.readFileSync(${JSON.stringify(path.join(root,'vendor/audio-enhancement/rnnoise-sync.js'))},'utf8')
 .replace('import.meta.url',${JSON.stringify(JSON.stringify('file://'+path.join(root,'vendor/audio-enhancement/rnnoise-sync.js')))})
 .replace('export default createRNNWasmModuleSync;','');
vm.runInThisContext(vendor);
const source=fs.readFileSync(${JSON.stringify(path.join(root,'audio-enhancement-worker.js'))},'utf8')
 .replace("import createRNNoise from './vendor/audio-enhancement/rnnoise-sync.js';",'const createRNNoise=createRNNWasmModuleSync;');
vm.runInThisContext(source);
parentPort.on('message',data=>self.onmessage({data}));
`;
function setup() {
  const instances=[];
  class BrowserWorker {
    constructor(url,options) {
      assert.match(url,/audio-enhancement-worker\.js/);assert.equal(options.type,'module');
      this.worker=new Worker(workerAdapter,{eval:true});this.terminated=false;instances.push(this);
      this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.(error));
    }
    postMessage(data) { this.worker.postMessage(data); }
    terminate() { this.terminated=true;this.worker.terminate(); }
  }
  const context={Blob,WebAssembly,Worker:BrowserWorker,URL,DOMException,setTimeout,clearTimeout,document:{currentScript:{src:'https://synap.test/audio-enhancement.js'}}};
  context.window=context;
  vm.runInNewContext(fs.readFileSync(path.join(root,'audio-enhancement.js'),'utf8'),context);
  return {api:context.SynapAudioEnhancement,instances};
}

test('bundled RNNoise suppression build has the pinned upstream bytes and both licenses',()=>{
  const digest=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'vendor/audio-enhancement/rnnoise-sync.js'))).digest('hex');
  assert.equal(digest,'05a553f523d59502d133a6d05dbf1878137c9e7bcff06edf5561f7001b62f95f');
  assert.match(fs.readFileSync(path.join(root,'vendor/audio-enhancement/LICENSE-JITSI.txt'),'utf8'),/Apache License/);
  assert.match(fs.readFileSync(path.join(root,'vendor/audio-enhancement/LICENSE-RNNOISE.txt'),'utf8'),/Jean-Marc Valin/);
});

test('actual local model reduces generated noise, preserves the WAV timeline and leaves its original intact',async()=>{
  const h=setup(),input=fixture(),bytes=wav(input),blob=new Blob([bytes],{type:'audio/wav'}),before=await blob.arrayBuffer(),progress=[];
  const result=await h.api.enhance(blob,{onProgress:value=>progress.push(value)}),encoded=new Uint8Array(await result.arrayBuffer()),output=pcm(encoded);
  assert.equal(result.type,'audio/wav');assert.equal(output.length,input.length);assert.equal(encoded.length,bytes.length);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),new Uint8Array(before));
  const noiseRatio=rms(output,8000,11000)/rms(input,8000,11000),voice=rms(output,18000,35000);
  let bestLag=0,bestCorrelation=-Infinity;
  for(let lag=-400;lag<=400;lag++) {
    let correlation=0;
    for(let i=18000;i<35000;i+=3)correlation+=input[i]*output[i+lag];
    if(correlation>bestCorrelation){bestCorrelation=correlation;bestLag=lag;}
  }
  console.log(JSON.stringify({noiseReductionDb:20*Math.log10(noiseRatio),syntheticVoiceRms:voice,outputSamples:output.length,bestLagSamples:bestLag}));
  assert.ok(noiseRatio<.85,'stationary noise is reduced conservatively');
  for(let i=0;i<input.length;i++)assert.ok(Math.abs(output[i])>=Math.abs(input[i])*.70-1,'no sample can be gated away by the denoiser');
  assert.ok(voice>20,'voiced test signal must not be replaced by silence');
  assert.ok(voice>rms(output,8000,11000),'voiced interval remains stronger than background');
  assert.ok(Math.abs(bestLag)<16,'model delay must be removed so speech still matches its source timestamps');
  assert.equal(progress.at(-1).stage,'complete');assert.equal(progress.at(-1).progress,1);
  const values=progress.filter(item=>item.stage==='processing').map(item=>item.progress);
  assert.ok(values.every((value,i)=>value>=0&&value<=1&&(!i||value>=values[i-1])));
  assert.equal(h.api.busy(),false);assert.ok(h.instances.every(worker=>worker.terminated));
});

test('actual model handles silence, sub-frame recordings and 48 kHz WAV without NaN or sample loss',async()=>{
  for(const [rate,count] of [[16000,1],[16000,159],[16000,481],[48000,1441]]) {
    const h=setup(),blob=new Blob([wav(new Int16Array(count),rate)]),result=await h.api.enhance(blob);
    const output=pcm(new Uint8Array(await result.arrayBuffer()));
    assert.equal(output.length,Math.ceil(count*16000/rate));assert.ok(output.every(value=>value===0));
    assert.equal(h.api.busy(),false);assert.ok(h.instances.every(worker=>worker.terminated));
  }
});

test('model output retains a non-silent final partial frame and handles padded WAV metadata',async()=>{
  const h=setup(),input=fixture(16000,2.017,{voiceThroughout:true}),result=await h.api.enhance(new Blob([wav(input,16000,{metadata:true})]));
  const output=pcm(new Uint8Array(await result.arrayBuffer()));
  assert.equal(output.length,input.length);
  assert.ok(rms(output,output.length-100)>20,'flush the final partial frame instead of losing its speech');
});

test('cancellation before and during processing rejects cleanly, frees Worker and allows the next job',async()=>{
  const h=setup(),blob=new Blob([wav(fixture(16000,8))]),already=new AbortController();already.abort();
  await assert.rejects(h.api.enhance(blob,{signal:already.signal}),{name:'AbortError'});assert.equal(h.instances.length,0);
  const controller=new AbortController();
  const pending=h.api.enhance(blob,{signal:controller.signal,onProgress:value=>{if(value.stage==='processing')controller.abort();}});
  assert.equal(h.api.busy(),true);
  await assert.rejects(h.api.enhance(blob),/Another recording/);
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(h.api.busy(),false);assert.ok(h.instances.every(worker=>worker.terminated));
  const result=await h.api.enhance(new Blob([wav(new Int16Array(160))]));assert.equal(result.size,364);
});

test('unsupported and corrupt WAV input fails without producing a copy or keeping a Worker alive',async()=>{
  const h=setup();
  for(const options of [{channels:2},{format:3},{bits:8}]) await assert.rejects(h.api.enhance(new Blob([wav(new Int16Array(100),16000,options)])),/mono 16-bit PCM/);
  await assert.rejects(h.api.enhance(new Blob([wav(new Int16Array(100),44100)])),/mono 16-bit PCM/);
  const broken=wav(new Int16Array(100));new DataView(broken.buffer).setUint32(40,90000,true);
  await assert.rejects(h.api.enhance(new Blob([broken])),/incomplete/);
  assert.equal(h.api.busy(),false);assert.ok(h.instances.every(worker=>worker.terminated));
});

test('duration limit rejects a long recording from metadata before loading audio/model',async()=>{
  const h=setup(),bytes=wav(new Int16Array(16000*1200+1));
  await assert.rejects(h.api.enhance(new Blob([bytes])),/up to 20 minutes/);
  assert.equal(h.api.busy(),false);assert.ok(h.instances.every(worker=>worker.terminated));
});

test('quiet voices and noise-like consonants retain their waveform instead of being gated out',async()=>{
  const h=setup(),input=fixture(16000,1.017,{voiceThroughout:true});
  for(let i=0;i<input.length;i++)input[i]=Math.round(input[i]*.035);
  const output=pcm(new Uint8Array(await (await h.api.enhance(new Blob([wav(input)]))).arrayBuffer()));
  let xy=0,xx=0,yy=0;
  for(let i=0;i<input.length;i++) {
    assert(Math.abs(output[i])>=Math.abs(input[i])*.7-1);
    xy+=input[i]*output[i];xx+=input[i]**2;yy+=output[i]**2;
  }
  assert(xy/Math.sqrt(xx*yy)>.95,'quiet waveform is retained without shifting its phase');
});

test('automatic preparation falls back on model failure or contention, while cancellation stops upload',async()=>{
  const h=setup(),bad=new Blob([wav(new Int16Array(100),44100)]);
  assert.equal(await h.api.prepareForUpload(bad),bad);
  const original=new Blob([wav(fixture(16000,2))]);
  const running=h.api.enhance(original);
  assert.equal(await h.api.prepareForUpload(original),original);
  await running;
  const controller=new AbortController();controller.abort();
  await assert.rejects(h.api.prepareForUpload(original,{signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(h.api.enhance(original,{timeoutMs:1}),/processing budget/);
  assert.equal(h.api.busy(),false);
});
