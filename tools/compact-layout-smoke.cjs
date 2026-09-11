/* Real-browser disclosure/palette checks and repeatable before/after page-height measurement.
 * SYNAP_UI_ROOT selects a baseline checkout; SYNAP_BASELINE=1 measures it without new-feature assertions.
 * Requires Playwright. Every recording is generated inside an isolated localhost browser profile. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=process.env.SYNAP_UI_ROOT||path.resolve(__dirname,'..'),out=process.env.SYNAP_UI_OUTPUT||'/tmp/synap-compact-measure';
const baseline=process.env.SYNAP_BASELINE==='1',measurements=[];
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data)})});
async function fixture(page){await page.evaluate(async()=>{
  const db=await new Promise(resolve=>{const r=indexedDB.open('dk-pendant-recordings');r.onsuccess=()=>resolve(r.result)});
  const summary='We reviewed the prototype microphone placement and agreed to compare the two enclosure designs. Alex will bring the revised drawings on Friday. The next test should cover a quiet room, a busy café, and walking outdoors. The team will use the same voice samples for every comparison, document the noise floor, and keep the original audio for review.';
  const samples=new Int16Array(16000),header=new DataView(new ArrayBuffer(44)),ascii=(at,s)=>[...s].forEach((c,i)=>header.setUint8(at+i,c.charCodeAt(0)));
  ascii(0,'RIFF');header.setUint32(4,32036,true);ascii(8,'WAVE');ascii(12,'fmt ');header.setUint32(16,16,true);header.setUint16(20,1,true);header.setUint16(22,1,true);header.setUint32(24,16000,true);header.setUint32(28,32000,true);header.setUint16(32,2,true);header.setUint16(34,16,true);ascii(36,'data');header.setUint32(40,32000,true);
  await new Promise(resolve=>{const tx=db.transaction('recordings','readwrite');for(let i=0;i<6;i++){
    const person=['Alex','Sam','Maya','Jordan','Riya','Chris'][i],createdAt=new Date(Date.now()-i*600000).toISOString();
    const conversation={title:['Prototype review','Launch checklist','Design discussion','Customer notes','Planning session','Team catch-up'][i],summary,participants:['You',person],start_ms:0,decisions:[{text:'Compare both enclosure designs.'}],action_items:[{task:'Bring revised drawings',owner:person,due_date:'2026-09-11'}],topics:['Prototype','Design'],people:[{name:person,role:'Collaborator'}]};
    tx.objectStore('recordings').put({id:'compact-'+i,name:conversation.title,createdAt,durationMs:1000,sizeBytes:32044,sampleRate:16000,processingStage:'ready',notes:'Keep the original notes.',summary,transcript:'You: Let’s compare both designs. '+person+': I will bring the drawings.',blob:new Blob([header.buffer,samples],{type:'audio/wav'}),meeting:{executive_summary:summary,conversations:[conversation],people:conversation.people}});
  }tx.oncomplete=resolve});db.close();document.getElementById('datePicker').dispatchEvent(new Event('change',{bubbles:true}));window.dispatchEvent(new CustomEvent('synap-memory-ready'));
});await page.waitForFunction(()=>document.getElementById('conversationCount').textContent==='6');await page.waitForTimeout(750)}
async function run(){fs.mkdirSync(out,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,...(process.env.SYNAP_CHROMIUM_PATH?{executablePath:process.env.SYNAP_CHROMIUM_PATH,args:['--no-sandbox','--no-zygote','--disable-dev-shm-usage']}:{})});
try{for(const width of[390,1440]){
 const context=await browser.newContext({viewport:{width,height:900},timezoneId:'Asia/Kolkata',reducedMotion:'reduce'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await context.addInitScript(()=>{if(!localStorage.getItem('synap-appearance'))localStorage.setItem('synap-appearance','light')});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.stack));await page.clock.install({time:new Date('2026-09-10T10:00:00Z')});
 await page.goto(origin);await page.waitForFunction(()=>window.SynapBrainUI&&window.SynapDashboardUI);await fixture(page);
 const height=await page.evaluate(()=>document.documentElement.scrollHeight);measurements.push({width,height});
 await page.screenshot({path:path.join(out,'overview-'+width+'.png'),fullPage:true});
 if(!baseline){
   for(const id of['capture','insights','library','synapWeeklyReview'])assert.equal(await page.locator('#'+id+' .tile-toggle').getAttribute('aria-expanded'),'false',id+' starts compact');
   assert.equal(await page.locator('.conversation-digest[open]').count(),0);
   const actionsToggle=page.locator('#myActions > .tile-heading .tile-toggle');await actionsToggle.focus();await page.keyboard.press('Space');assert(!(await page.locator('#myActionsBody').isVisible()));await page.keyboard.press('Space');assert(await page.locator('#myActionsBody').isVisible());
   await page.locator('.conversation-card').first().click();assert(await page.locator('.conversation-source').first().isVisible());await page.locator('.conversation-source').first().click();
   await page.waitForFunction(()=>document.getElementById('recording-compact-0')?.open);
   assert(await page.locator('#libraryBody').isVisible(),'source navigation expands Library');
   await page.locator('#recording-compact-0 audio').evaluate(node=>{window.savedPlayer=node});
   const notes=page.locator('#recording-compact-0 .recording-notes');await notes.evaluate(node=>{window.savedNotes=node;node.closest('details').open=true});await notes.fill('An edit that must survive collapse.');
   await page.locator('#library .tile-toggle').click();assert(!(await page.locator('#libraryBody').isVisible()));
   await page.locator('.brain-tabs a[href="#library"]').click();assert(await page.locator('#recording-compact-0 audio').evaluate(node=>node===window.savedPlayer));assert.equal(await notes.inputValue(),'An edit that must survive collapse.');
   await page.locator('.brain-tabs a[href="#insights"]').click();const memory=page.locator('#insightsList .insight-card').first();await memory.locator('summary.insight-top').click();assert(await memory.evaluate(node=>node.open));
   await page.evaluate(()=>document.getElementById('datePicker').dispatchEvent(new Event('change',{bubbles:true})));await page.waitForTimeout(200);assert(await memory.evaluate(node=>node.open),'memory stays open through data refresh');
   await page.evaluate(()=>{document.body.dataset.state='recording'});assert(await page.locator('#captureBody').isVisible());assert(await page.locator('#stopButton').isVisible());await page.evaluate(()=>{document.body.dataset.state='disconnected'});
   while(await page.locator('main>.workspace-tile.is-expanded .tile-toggle').count())await page.locator('main>.workspace-tile.is-expanded .tile-toggle').first().click();
   await page.locator('.brain-tabs a[href="#today"]').click();
   await page.locator('#settingsButton').click();
   const colors=new Set();
   for(const palette of['olive','blue','pink','lavender'])for(const mode of['light','dark']){
     await page.locator('[data-theme-choice="'+mode+'"]').click();await page.locator('[data-palette-choice="'+palette+'"]').click();
     assert.equal(await page.locator('html').getAttribute('data-theme'),mode);assert.equal(await page.locator('html').getAttribute('data-palette'),palette);
     assert.equal(await page.evaluate(()=>localStorage.getItem('synap-appearance')),mode);assert.equal(await page.evaluate(()=>localStorage.getItem('synap-palette')),palette);
     const color=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());colors.add(color);
     assert(await page.evaluate(()=>{const button=document.querySelector('.synap-account button');if(!button)return true;const hex=getComputedStyle(document.documentElement).getPropertyValue('--on-action').trim(),rgb=hex.slice(1).match(/../g).map(c=>parseInt(c,16));return getComputedStyle(button).color==='rgb('+rgb.join(', ')+')'}),'account action uses the correct contrasting text color');
     const prefix=palette==='olive'?'':palette+'-';
     for(const logo of await page.locator('.synap-brand-image').all()){assert.equal(await logo.getAttribute('src'),'synap-logo-'+prefix+mode+'.png?v=1.0.0-ui-fix1');assert(await logo.evaluate(async img=>{await img.decode();return img.naturalWidth===800}))}
     await page.locator('#settingsDialog').screenshot({path:path.join(out,`palette-${palette}-${mode}-${width}.png`)});
     await page.locator('#closeSettingsButton').click();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(out,`home-${palette}-${mode}-${width}.png`)});await page.locator('#settingsButton').click();
   }
   assert.equal(colors.size,8);
   await page.locator('[data-palette-choice="pink"]').click();await page.locator('[data-theme-choice="system"]').click();
   await page.clock.setSystemTime(new Date('2026-09-10T15:00:00Z'));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
   assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(await page.locator('html').getAttribute('data-palette'),'pink');
   await page.reload();await page.waitForFunction(()=>window.SynapCompactLayout);assert.equal(await page.locator('html').getAttribute('data-palette'),'pink');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
   assert.equal(await page.locator('#library .tile-toggle').getAttribute('aria-expanded'),'false','manual collapse persists');
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert(!overflow);
 }
 assert.deepEqual(errors,[]);await context.close();console.log('PASS '+width+'px; initial populated page '+height+'px');
}fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify(measurements,null,2));}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}}
run().catch(error=>{console.error(error);server.close();process.exitCode=1});
