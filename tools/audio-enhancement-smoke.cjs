/* Public browser API + real bundled RNNoise. No credentials or user audio.
 * NODE_PATH=<Playwright dependencies> SYNAP_CHROMIUM_PATH=<Chromium> node tools/audio-enhancement-smoke.cjs
 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const {wav,fixture}=require('./audio-enhancement-fixtures.cjs');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/__enhancement') {
    res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><title>Local enhancement check</title><script src="audio-enhancement.js"></script>');return;
  }
  const file=path.resolve(root,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{
    if(error){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.html')?'text/html':'application/octet-stream'}).end(data);
  });
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.SYNAP_CHROMIUM_PATH||undefined,
    args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const context=await browser.newContext(),external=[],errors=[];
    await context.route('**/*',route=>{
      if(!route.request().url().startsWith(origin+'/')){external.push(route.request().url());return route.abort();}
      return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/__enhancement');
    const bytes=[...wav(fixture())];
    const result=await page.evaluate(async bytes=>{
      const api=window.SynapAudioEnhancement,source=new Blob([new Uint8Array(bytes)],{type:'audio/wav'}),progress=[];
      const started=performance.now(),copy=await api.enhance(source,{onProgress:item=>progress.push(item)});
      const result=new Uint8Array(await copy.arrayBuffer()),view=new DataView(result.buffer);
      const before=new Uint8Array(await source.arrayBuffer());
      let noise=0,voice=0;
      for(let i=8000;i<11000;i++)noise+=view.getInt16(44+i*2,true)**2;
      for(let i=18000;i<35000;i++)voice+=view.getInt16(44+i*2,true)**2;
      return {supported:api.supported(),size:copy.size,rate:view.getUint32(24,true),
        noiseRms:Math.sqrt(noise/3000),voiceRms:Math.sqrt(voice/17000),
        preserved:before.every((value,i)=>value===bytes[i]),busy:api.busy(),last:progress.at(-1),elapsedMs:performance.now()-started};
    },bytes);
    assert.equal(result.supported,true);assert.equal(result.size,bytes.length);assert.equal(result.rate,16000);
    assert.equal(result.preserved,true);assert.equal(result.busy,false);assert.equal(result.last.stage,'complete');
    assert.ok(result.voiceRms>result.noiseRms*3);assert.ok(result.voiceRms>20);
    const cancelled=await page.evaluate(async bytes=>{
      const controller=new AbortController();
      try{await SynapAudioEnhancement.enhance(new Blob([new Uint8Array(bytes)]),{signal:controller.signal,
        onProgress:item=>{if(item.stage==='processing')controller.abort();}});return false;}
      catch(error){return error.name==='AbortError'&&!SynapAudioEnhancement.busy();}
    },bytes);
    assert.equal(cancelled,true);
    // Verify the production service worker can serve the model and module Worker offline.
    await page.evaluate(async()=>{
      const registration=await navigator.serviceWorker.register('./sw.js');
      await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Production service worker installation did not complete.')),10000))]);
      if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
      return !!registration.active;
    });
    await page.reload();
    await context.setOffline(true);
    const offline=await page.evaluate(async bytes=>{
      const output=await SynapAudioEnhancement.enhance(new Blob([new Uint8Array(bytes)]));
      return {size:output.size,busy:SynapAudioEnhancement.busy()};
    },bytes);
    assert.equal(offline.size,bytes.length);assert.equal(offline.busy,false);
    assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({status:'passed',online:result,offline,cancelled,externalRequests:external.length},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
