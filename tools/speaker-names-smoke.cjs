'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=process.env.SYNAP_SPEAKERS_OUTPUT||'/tmp/synap-speakers-qa';
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/^\/$/,'/index.html'));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data)})});
async function run(){
 fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,...(process.env.SYNAP_CHROMIUM_PATH?{executablePath:process.env.SYNAP_CHROMIUM_PATH,args:['--no-sandbox']}:{})});
 try{for(const [mode,width] of [['light',320],['dark',390],['light',1440]]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  await context.addInitScript(mode=>{
   localStorage.setItem('synap-appearance',mode);
   window.qaSpeakers={failure:false,posts:0,raw:'[00:01] S1: I will send S2 the drawings.\n[00:04] S2: Thank you.'};
   document.addEventListener('DOMContentLoaded',()=>{
    window.SynapAuth={...window.SynapAuth,isSignedIn:()=>true,authedFetch:async(url,options={})=>{
     if(!url.endsWith('/speaker-fixture/speakers'))return new Response(JSON.stringify({error:{message:'No fixture for this request'}}),{status:404});
     const qa=qaSpeakers,saved=JSON.parse(sessionStorage.getItem('qa-speakers')||'{"names":{},"revision":"v1"}');
     if(options.method!=='POST')return new Response(JSON.stringify({revision:saved.revision,speaker_names:saved.names,speakers:[{label:'S1',excerpt:'I will send S2 the drawings.'},{label:'S2',excerpt:'Thank you.'}]}));
     qa.posts++;qa.lastBody=JSON.parse(options.body);
     if(qa.failure)return new Response(JSON.stringify({error:{message:'Temporary summary failure'}}),{status:503});
     if(qa.lastBody.revision!==saved.revision)return new Response(JSON.stringify({error:{message:'Recording changed'}}),{status:409});
     const names=Object.fromEntries(Object.entries(qa.lastBody.speaker_names).filter(([,name])=>name));
     const transcript=qa.raw.replace(/S1:/g,(names.S1||'S1')+':').replace(/S2:/g,(names.S2||'S2')+':');
     const summary=(names.S1||'S1')+' will send the drawings to '+(names.S2||'S2')+'.',revision=saved.revision+'x';
     sessionStorage.setItem('qa-speakers',JSON.stringify({names,revision}));
     return new Response(JSON.stringify({schema_version:1,title:'Drawing review',executive_summary:summary,key_points:[],people:[],topics:['Drawings'],conversations:[{title:'Drawing review',summary,start_ms:0,end_ms:6000,participants:Object.values(names),mentioned_people:[],people:[],decisions:[],action_items:[],follow_ups:[],topics:[]}],transcript,raw_transcript:qa.raw,speaker_names:names,revision,day_updated:true,duration_ms:6000}));
    }};
   });
  },mode);
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);await page.waitForFunction(()=>window.SynapBackend&&window.SynapSpeakerNames);
  await page.evaluate(async()=>{
   const db=await new Promise(resolve=>{const r=indexedDB.open('dk-pendant-recordings');r.onsuccess=()=>resolve(r.result)});
   await new Promise(resolve=>{const tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').put({id:'speaker-fixture',name:'Drawing review',createdAt:new Date().toISOString(),durationMs:6000,provider:'synap',processingStage:'ready',processingState:'done',notes:'Keep my notes',blob:new Blob(['original-audio']),transcript:qaSpeakers.raw,summary:'Someone will send the drawings.',meeting:{executive_summary:'Someone will send the drawings.',conversations:[{title:'Drawing review',summary:'Someone will send the drawings.',start_ms:0,end_ms:6000,participants:[],mentioned_people:[],people:[],decisions:[],action_items:[],follow_ups:[],topics:[]}]}});tx.oncomplete=resolve});db.close();window.dispatchEvent(new Event('synap-memory-ready'));
  });
  await page.evaluate(()=>document.getElementById('datePicker').dispatchEvent(new Event('change',{bubbles:true})));
  async function open(){await page.locator('.brain-tabs a[href="#library"]').click();const card=page.locator('#recording-speaker-fixture');await card.locator(':scope > summary').click();await card.locator('.recording-transcript').evaluate(node=>node.closest('details').open=true);await card.locator('.speaker-names > summary').click();await page.getByLabel('Name for S1',{exact:true}).waitFor();return card}
  const card=await open(),save=card.locator('.speaker-name-actions [type="submit"]');
  await page.getByLabel('Name for S1',{exact:true}).fill('Divyan');await page.getByLabel('Name for S2',{exact:true}).fill('Riya');
  await page.evaluate(()=>qaSpeakers.failure=true);await save.click();await page.waitForFunction(()=>document.querySelector('.speaker-names-status').textContent.includes('Temporary summary failure'));
  assert.equal(await card.locator('.recording-transcript').inputValue(),await page.evaluate(()=>qaSpeakers.raw));
  assert.equal(await page.getByLabel('Name for S1',{exact:true}).inputValue(),'Divyan','failed saves retain the draft');
  await page.evaluate(()=>qaSpeakers.failure=false);await save.click();await page.waitForFunction(()=>document.querySelector('.speaker-names-status').textContent==='Names and summaries updated.');
  assert.match(await card.locator('.recording-transcript').inputValue(),/\[00:01\] Divyan: I will send S2 the drawings/);
  await page.waitForFunction(()=>document.querySelector('#recording-speaker-fixture .recording-summary').textContent.includes('Divyan will send the drawings to Riya'));
  await page.waitForFunction(()=>document.getElementById('dayBriefText').textContent.includes('Divyan'));
  await page.locator('.speaker-names').screenshot({path:path.join(out,`speakers-${mode}-${width}.png`)});
  await page.reload();const reloaded=await open();assert.equal(await page.getByLabel('Name for S1',{exact:true}).inputValue(),'Divyan');
  await page.evaluate(()=>document.body.dataset.state='recording');const count=await page.evaluate(()=>qaSpeakers.posts);await reloaded.locator('.speaker-name-actions [type="submit"]').click();assert.equal(await page.evaluate(()=>qaSpeakers.posts),count,'editing must not launch a summary rebuild during capture');await page.evaluate(()=>document.body.dataset.state='disconnected');
  await page.getByLabel('Name for S1',{exact:true}).fill('');await page.getByLabel('Name for S2',{exact:true}).fill('');await reloaded.locator('.speaker-name-actions [type="submit"]').click();await page.waitForFunction(()=>document.querySelector('.speaker-names-status').textContent==='Names and summaries updated.');
  assert.equal(await reloaded.locator('.recording-transcript').inputValue(),await page.evaluate(()=>qaSpeakers.raw),'clearing names restores the original labels');
  const stored=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('dk-pendant-recordings');r.onsuccess=()=>resolve(r.result)});const value=await new Promise(resolve=>{const r=db.transaction('recordings').objectStore('recordings').get('speaker-fixture');r.onsuccess=()=>resolve(r.result)});db.close();return{raw:value.rawTranscript,notes:value.notes,blobSize:value.blob.size}});
  assert.equal(stored.raw,await page.evaluate(()=>qaSpeakers.raw));assert.equal(stored.notes,'Keep my notes');assert.equal(stored.blobSize,14);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  console.log(`PASS speakers/${mode}/${width}: tag, retry, summary/day refresh, reload, clear names and original evidence retained`);await context.close();
 }}finally{await browser.close();server.close()}
}
run().catch(error=>{console.error(error);server.close();process.exitCode=1});
