/* Browser-only UI smoke checks. Requires Playwright; no BLE/cloud credentials.
 * Run: node tools/ui-smoke.cjs
 * Optional: SYNAP_CHROMIUM_PATH and SYNAP_UI_OUTPUT for local QA environments.
 * The server binds only to localhost; external browser requests are blocked.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.SYNAP_UI_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'synap-ui-'));
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png' };

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(bytes);
  });
});

async function assertWordmarks(page, mode) {
  for (const selector of ['.brand-logo']) {
    const logo=page.locator(selector);
    assert.match(await logo.getAttribute('src'),new RegExp('synap-logo-'+mode+'\\.png\\?v=1\\.0\\.0-ui-fix1$'));
    const pixels=await logo.evaluate(async img=>{
      await img.decode();
      const canvas=document.createElement('canvas');canvas.width=800;canvas.height=216;
      const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,800,216);
      const data=ctx.getImageData(208,0,592,216).data;let count=0,r=0,g=0,b=0;
      for(let i=0;i<data.length;i+=4)if(data[i+3]>220){count++;r+=data[i];g+=data[i+1];b+=data[i+2];}
      return {width:img.naturalWidth,count,r:r/count,g:g/count,b:b/count};
    });
    assert.equal(pixels.width,800);assert(pixels.count>5000,'wordmark has actual visible pixels');
    const expected=mode==='dark'?[237,245,239]:[24,60,52];
    ['r','g','b'].forEach((c,i)=>assert(Math.abs(pixels[c]-expected[i])<2,`${mode} wordmark color ${c}`));
  }
}

async function assertWeeklyReview(page, mode, width) {
  await page.evaluate(()=>SynapCompactLayout.reveal('synapWeeklyReview'));
  // These generated records exist only in this isolated localhost test profile.
  await page.waitForFunction(()=>window.SynapProductivity&&document.querySelector('#synapWeekDetail .synap-week-source'));
  assert.equal(await page.locator('#synapWeekDetail .synap-week-source').first().getAttribute('data-recording-id'),'ui-sample');
  await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('dk-pendant-recordings');request.onsuccess=()=>resolve(request.result)});
    const sample=await new Promise(resolve=>{const request=db.transaction('recordings').objectStore('recordings').get('ui-sample');request.onsuccess=()=>resolve(request.result)});
    const start=new Date(SynapProductivity.weekRange(new Date().toLocaleDateString('en-CA')).start+'T00:00:00');
    await new Promise((resolve,reject)=>{const tx=db.transaction('recordings','readwrite'),store=tx.objectStore('recordings');
      for(let i=0;i<35;i++)store.put({...sample,id:'weekly-history-'+String(i).padStart(2,'0'),name:'Earlier weekly source '+i,createdAt:new Date(start.getTime()+i*60000).toISOString()});
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });db.close();window.dispatchEvent(new CustomEvent('synap-memory-ready'));
  });
  await page.waitForFunction(()=>document.querySelector('[data-week-view="conversations"]').textContent==='36 conversations');
  const rows=page.locator('#synapWeekDetail .synap-week-source');
  assert.equal(await rows.count(),5);assert.equal(await rows.first().getAttribute('data-recording-id'),'ui-sample','today is before all older weekly records');
  assert.match(await rows.first().locator('time').innerText(),/^Today/);
  await page.evaluate(()=>SynapCloudHistory.refreshUiInPlace({source:'isolated-weekly-fixture'}));
  await page.waitForTimeout(180);
  assert(await page.locator('#synapWeekDetail').isVisible(),'cloud refresh does not collapse Weekly Review');
  for(let i=0;i<7&&await page.locator('#synapWeekMore').isVisible();i++)await page.locator('#synapWeekMore').click();
  assert.equal(await rows.count(),36,'older evidence is paginated, never silently discarded');
  await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('dk-pendant-recordings');request.onsuccess=()=>resolve(request.result)});
    const sample=await new Promise(resolve=>{const request=db.transaction('recordings').objectStore('recordings').get('ui-sample');request.onsuccess=()=>resolve(request.result)});
    await new Promise((resolve,reject)=>{const tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').put({...sample,id:'weekly-today-new',createdAt:new Date().toISOString(),name:'New conversation today',summary:'',transcript:'',meeting:{},processingStage:'transcribing'});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
    db.close();window.dispatchEvent(new CustomEvent('synap-recording-saved'));
  });
  await page.waitForTimeout(160);
  assert.equal(await page.locator('[data-week-view="conversations"]').innerText(),'36 conversations','pending audio is not miscounted as a processed conversation');
  await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('dk-pendant-recordings');request.onsuccess=()=>resolve(request.result)});
    const sample=await new Promise(resolve=>{const request=db.transaction('recordings').objectStore('recordings').get('weekly-today-new');request.onsuccess=()=>resolve(request.result)});
    sample.meeting={conversations:[{title:'Today’s new conversation',summary:'A newly processed discussion about the prototype.',start_ms:0}]};sample.summary='A newly processed discussion about the prototype.';sample.processingStage='ready';
    await new Promise((resolve,reject)=>{const tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').put(sample);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
    db.close();window.dispatchEvent(new CustomEvent('synap-processing-complete'));
  });
  await page.waitForFunction(()=>document.querySelector('[data-week-view="conversations"]').textContent==='37 conversations');
  assert.equal(await rows.first().getAttribute('data-recording-id'),'weekly-today-new','newly processed source appears without reload');
  await page.locator('[data-week-view="decisions"]').click();await page.locator('[data-week-view="conversations"]').click();
  await page.locator('#synapWeeklyReview').screenshot({path:path.join(output,`weekly-${mode}-${width}.png`)});
  await rows.first().click();
  await page.waitForFunction(()=>document.getElementById('recording-weekly-today-new')?.open);
  assert(await page.locator('#recording-weekly-today-new .recording-content').isVisible(),'weekly source opens its exact Library recording');
  await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('dk-pendant-recordings');request.onsuccess=()=>resolve(request.result)});
    await new Promise((resolve,reject)=>{const tx=db.transaction('recordings','readwrite'),store=tx.objectStore('recordings');for(let i=0;i<35;i++)store.delete('weekly-history-'+String(i).padStart(2,'0'));store.delete('weekly-today-new');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
    SynapCloudHistory.refreshUiInPlace({source:'isolated-weekly-fixture-cleanup'});await SynapProductivity.refresh(false);
  });
  await page.waitForFunction(()=>document.querySelectorAll('.recording-card').length===1);
  await page.locator('.brain-tabs a[href="#today"]').click();
  console.log(`PASS weekly/${mode}/${width}: today first, all weekly evidence, processing events, persistent detail, exact source navigation`);
}

async function assertDayReading(page,mode,width){
  await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('dk-pendant-recordings');request.onsuccess=()=>resolve(request.result)});
    const sample=await new Promise(resolve=>{const request=db.transaction('recordings').objectStore('recordings').get('ui-sample');request.onsuccess=()=>resolve(request.result)});
    const prior=new Date();prior.setDate(prior.getDate()-1);
    const summary='The prototype needs a quieter microphone mount. '+ 'We reviewed the enclosure, materials, and next steps in detail. '.repeat(12)+'Final detail: bring the revised drawings on Friday.';
    const conversations=Array.from({length:10},(_,i)=>({...sample.meeting.conversations[0],title:'Design discussion '+i,start_ms:i*100,summary:summary+' Conversation '+i}));
    await new Promise((resolve,reject)=>{const tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').put({...sample,id:'day-reading',name:'Earlier design review',createdAt:prior.toISOString(),summary,meeting:{executive_summary:summary,conversations}});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
    window.dispatchEvent(new CustomEvent('synap-memory-ready'));
  });
  await page.locator('.brain-tabs a[href="#today"]').click();
  await page.locator('[data-day-step="-1"]').click();
  await page.waitForFunction(()=>document.querySelector('#conversationCount').textContent==='10');
  assert.equal(await page.locator('#dayLensTitle').innerText(),'Yesterday');
  assert.equal(await page.locator('#dateStrip .date-chip').count(),7);
  assert.match(await page.locator('#dateStrip .selected').getAttribute('aria-label'),/1 saved recording/);
  assert.equal(await page.locator('.conversation-digest').count(),3);
  await page.locator('#dayBriefReadMore').click();
  assert.match(await page.locator('#dayBriefText').innerText(),/Final detail: bring the revised drawings on Friday/);
  assert(await page.locator('#dayBriefSources').isVisible());
  assert.equal(await page.locator('#dayBriefReadMore').getAttribute('aria-expanded'),'true');
  await page.locator('.conversation-digest').nth(1).locator('summary').click();
  await page.evaluate(()=>SynapBrainUI.refresh());
  assert(await page.locator('.conversation-digest').nth(1).evaluate(node=>node.open),'refresh preserves expanded reading');
  while(await page.locator('#showMoreConversations').isVisible())await page.locator('#showMoreConversations').click();
  assert.equal(await page.locator('.conversation-digest').count(),10,'all conversations remain accessible');
  assert.equal(await page.locator('#conversationPageCount').innerText(),'10 of 10 summaries');
  await page.locator('#today').screenshot({path:path.join(output,`day-reading-${mode}-${width}.png`)});
  await page.locator('.conversation-digest').first().evaluate(node=>node.open=true);
  await page.locator('.conversation-source').first().click();
  await page.waitForFunction(()=>document.getElementById('recording-day-reading')?.open);
  await page.locator('.brain-tabs a[href="#today"]').click();
  const selected=await page.locator('#datePicker').inputValue();
  await page.locator('[data-day-step="-7"]').click();
  assert.notEqual(await page.locator('#datePicker').inputValue(),selected);
  await page.locator('[data-day-step="7"]').click();
  assert.equal(await page.locator('#datePicker').inputValue(),selected);
  await page.locator('#jumpToToday').click();
  await page.waitForFunction(()=>document.getElementById('conversationCount').textContent==='1');
  assert(await page.locator('[data-day-step="1"]').isDisabled());
  assert.equal(await page.locator('#dayBriefReadMore').getAttribute('aria-expanded'),'false');
  await page.locator('#dateStrip [data-day="'+selected+'"]').click();
  await page.waitForFunction(()=>document.getElementById('conversationCount').textContent==='10');
  await page.locator('#jumpToToday').click();
  await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('dk-pendant-recordings');r.onsuccess=()=>resolve(r.result)});
    await new Promise(resolve=>{const tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').delete('day-reading');tx.oncomplete=resolve});db.close();SynapCloudHistory.refreshUiInPlace({source:'day-reading-cleanup'});
  });
  await page.waitForFunction(()=>document.querySelectorAll('.recording-card').length===1);
  console.log(`PASS reading/${mode}/${width}: day/week/tile navigation, full brief, all 10 summaries, source and reading state`);
}

async function run() {
  fs.mkdirSync(output, { recursive:true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:true,
    ...(process.env.SYNAP_CHROMIUM_PATH ? { executablePath:process.env.SYNAP_CHROMIUM_PATH, args:['--no-sandbox','--no-zygote','--disable-dev-shm-usage'] } : {}) });
  try {
    for (const mode of ['light','dark']) for (const width of [320,390,768,1440]) {
      const context = await browser.newContext({ viewport:{width,height:900}, reducedMotion:'reduce',colorScheme:mode==='light'?'dark':'light',timezoneId:'Asia/Kolkata' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(theme => localStorage.setItem('synap-appearance', theme), mode);
      const page = await context.newPage();
      // A running clock anchored at midday keeps multi-minute QA from crossing
      // local midnight and changing the meaning of "today" halfway through.
      await page.clock.install({time:new Date('2026-09-10T10:00:00Z')});
      const errors=[]; page.on('pageerror', error => errors.push(error.stack||error.message));
      await page.goto(origin);
      await page.waitForFunction(() => window.SynapDashboardUI && document.querySelectorAll('.brain-tabs a').length === 5);
      await page.waitForTimeout(800);
      assert.equal(await page.locator('.brain-tabs a[aria-current="page"]').getAttribute('href'),'#today','initial view');
      assert.equal(await page.locator('html').getAttribute('data-theme'), mode);
      await assertWordmarks(page,mode);
      assert.equal(await page.locator('.brand-logo').evaluate(node=>getComputedStyle(node).filter),'none','preserve two-tone branding');
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.app-shell,.topbar,main>section,.brain-tabs')]
        .filter(node => { const r=node.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); })
        .map(node => node.id || node.className));
      assert.deepEqual(overflow, [], `${mode}/${width}: horizontal overflow`);
      assert.equal(await page.locator('link[href^="compact.css"]').count(),1,'single presentation stylesheet');
      assert(!(await page.locator('#startButton').isVisible()),'idle capture starts collapsed');
      assert(await page.locator('#headerCaptureToggle').isVisible(),'persistent recording shortcut stays available');
      assert(await page.locator('#startButton').isDisabled());
      assert(!(await page.locator('#stopButton').isVisible()));
      if (width===390 || width===1440) {
        await page.screenshot({path:path.join(output,`${mode}-${width}.png`),fullPage:true});
        await page.screenshot({path:path.join(output,`home-${mode}-${width}.png`)});
        await page.locator('.brand-logo').screenshot({path:path.join(output,`brand-${mode}-${width}.png`)});
      }
      for (const href of ['#capture','#insights','#myActions','#library','#today']) {
        await page.locator(`.brain-tabs a[href="${href}"]`).click();
        assert.equal(await page.locator('.brain-tabs a[aria-current="page"]').count(),1);
        assert.equal(await page.locator('.brain-tabs a[aria-current="page"]').getAttribute('href'),href);
        assert(await page.locator(href).isVisible());
      }
      // Focus tabs keep their selection through memory refresh and work by keyboard.
      await page.evaluate(()=>SynapCompactLayout.reveal('dailyFocus'));
      await page.locator('#focusCommitments').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#focusDecisions').getAttribute('aria-selected'),'true');
      assert(await page.locator('#focusDecisionsPanel').isVisible());
      assert(!(await page.locator('#focusCommitmentsPanel').isVisible()));
      await page.keyboard.press('End');
      assert.equal(await page.locator('#focusWaiting').getAttribute('aria-selected'),'true');
      await page.keyboard.press('Home');
      assert.equal(await page.locator('#focusCommitments').getAttribute('aria-selected'),'true');
      for (const target of ['synapWeeklyReview','peopleMemory','followupInbox']) {
        await page.evaluate(id=>SynapCompactLayout.reveal(id),target);
        assert(await page.locator('#'+(target==='synapWeeklyReview'?target+'Body':target)).isVisible(),'secondary surface opens without recreating content');
        await page.locator('.brain-tabs a[href="#today"]').click();
      }
      await page.locator('#settingsButton').click();
      assert(await page.locator('#settingsDialog').isVisible());
      assert.equal(await page.locator('.settings-brand-logo').count(),0,'the persistent header is the only wordmark');
      assert(await page.locator('#headerPendantStatus').isVisible());
      assert(await page.locator('#otaStatus').isVisible());
      assert(!(await page.locator('#otaLatest').isVisible()),'no phantom firmware update');
      assert(!(await page.locator('#otaCancel').isVisible()),'no phantom OTA cancel');
      await page.locator('[data-theme-choice="dark"]').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
      await assertWordmarks(page,'dark');
      await page.locator('[data-theme-choice="light"]').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
      await assertWordmarks(page,'light');
      await page.locator(`[data-theme-choice="${mode}"]`).click();
      if(width===390) await page.screenshot({path:path.join(output,'settings-390.png')});
      await page.locator('#closeSettingsButton').click();
      assert(!(await page.locator('#settingsDialog').isVisible()));
      if (width===390 || width===1440) {
        // Isolated localhost fixture; these sample records never touch user data.
        await page.evaluate(async () => {
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('dk-pendant-recordings');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const pcm=new Int16Array(16000);
          const header=new DataView(new ArrayBuffer(44));
          const ascii=(offset,value)=>[...value].forEach((c,i)=>header.setUint8(offset+i,c.charCodeAt(0)));
          ascii(0,'RIFF');header.setUint32(4,36+pcm.byteLength,true);ascii(8,'WAVE');ascii(12,'fmt ');
          header.setUint32(16,16,true);header.setUint16(20,1,true);header.setUint16(22,1,true);
          header.setUint32(24,16000,true);header.setUint32(28,32000,true);header.setUint16(32,2,true);header.setUint16(34,16,true);
          ascii(36,'data');header.setUint32(40,pcm.byteLength,true);
          const createdAt=new Date().toISOString();
          const conversation={title:'Prototype planning',summary:'We agreed to test the new prototype before choosing the final enclosure.',start_ms:0,end_ms:1000,participants:['You','Alex'],people:[{name:'Alex',role:'Collaborator'}],topics:['Prototype'],decisions:['Test the prototype before selecting the enclosure.'],action_items:[{task:'Prepare the prototype test checklist.',owner:'self',status:'open'}],follow_ups:[]};
          const record={id:'ui-sample',name:'Sample · Prototype planning',createdAt,durationMs:1000,sampleRate:16000,sizeBytes:32044,processingStage:'ready',
            blob:new Blob([header.buffer,pcm],{type:'audio/wav'}),notes:'Sample data for UI testing only.',
            transcript:'Alex: Let’s test the prototype before deciding on an enclosure. You: I’ll prepare the test checklist.',
            summary:conversation.summary,meeting:{executive_summary:conversation.summary,conversations:[conversation],people:conversation.people,decisions:conversation.decisions,action_items:conversation.action_items,topics:['Prototype']}};
          await new Promise((resolve,reject)=>{const tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').put(record);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
        });
        await page.reload();
        await page.waitForFunction(()=>document.querySelectorAll('.recording-card').length===1);
        await page.waitForTimeout(900);
        assert.equal(await page.locator('#glanceRecordings').innerText(),'1');
        assert.equal(await page.locator('#commitmentCount').innerText(),'1');
        await page.locator('#conversationList .conversation-card').first().click();
        assert(await page.locator('#conversationList .digest-summary').innerText());
        assert.match(await page.locator('#conversationList .conversation-people').innerText(),/Alex/);
        await page.evaluate(()=>SynapCompactLayout.reveal('dailyFocus'));
        await page.locator('#focusDecisions').click();
        await page.evaluate(()=>SynapCloudHistory.refreshUiInPlace({source:'isolated-focus-fixture'}));
        await page.waitForTimeout(200);
        assert.equal(await page.locator('#focusDecisions').getAttribute('aria-selected'),'true');
        await page.locator('#focusCommitments').click();
        await page.waitForSelector('#todayMemoryPipeline');
        assert(!(await page.locator('#todayMemoryPipeline').evaluate(node=>node.open)),'processing details start compact');
        assert.equal(await page.locator('.brief-intro #todayMemoryPipeline').count(),0,'processing status stays outside the hero');
        await page.locator('#todayMemoryPipeline>summary').click();
        assert(await page.locator('#todayMemoryPipeline .today-memory-track').isVisible());
        await page.evaluate(()=>SynapTodayPipeline.refresh());
        assert(await page.locator('#todayMemoryPipeline').evaluate(node=>node.open),'processing updates preserve the disclosure');
        await page.locator('#todayMemoryPipeline>summary').click();
        await assertWeeklyReview(page,mode,width);
        await assertDayReading(page,mode,width);
        await page.locator('.brain-tabs a[href="#insights"]').click();
        await page.locator('.brain-tabs a[href="#library"]').click();
        await page.locator('[data-library-scope="all"]').click();
        await page.locator('#librarySearch').fill('prototype');
        await page.waitForFunction(()=>document.querySelector('#librarySearchStatus').textContent==='1 matching recording');
        await page.locator('#clearLibrarySearch').click();
        await page.locator('.brain-tabs a[href="#library"]').click();
        await page.locator('.recording-card>summary').click();
        await page.waitForFunction(()=>document.querySelector('.recording-action-export')?.disabled===false);
        assert(await page.locator('.recording-action-export').isVisible());
        assert(await page.locator('.recording-action-delete').isVisible());
        assert.equal(await page.locator('.recording-card audio').evaluate(audio=>audio.readyState>=1),true,'playable local WAV');
        const download=page.waitForEvent('download');await page.locator('.recording-action-export').click();
        assert((await download).suggestedFilename().endsWith('.wav'));
        const speech=page.locator('#recording-ui-sample .speech-enhancement');
        await speech.locator('[data-speech="enhance"]').click();
        await speech.locator('[data-speech="export"]').waitFor({state:'visible'});
        assert.equal(await speech.locator('[data-speech="enhanced"]').getAttribute('aria-pressed'),'true');
        const enhancedSource=await page.locator('#recording-ui-sample audio').getAttribute('src');
        await speech.locator('[data-speech="original"]').click();
        assert.notEqual(await page.locator('#recording-ui-sample audio').getAttribute('src'),enhancedSource);
        await speech.locator('[data-speech="enhanced"]').click();
        assert.equal(await page.locator('#recording-ui-sample audio').getAttribute('src'),enhancedSource);
        const enhancedDownload=page.waitForEvent('download');await speech.locator('[data-speech="export"]').click();
        const copy=await enhancedDownload;assert(copy.suggestedFilename().endsWith('-enhanced.wav'));
        const wav=fs.readFileSync(await copy.path());assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.length,32044);
        await page.evaluate(()=>{document.body.dataset.state='recording'});
        assert(await speech.locator('[data-speech="enhance"]').isDisabled(),'enhancement yields resources to live capture');
        await page.evaluate(()=>{document.body.dataset.state='disconnected'});
        await speech.screenshot({path:path.join(output,`speech-${mode}-${width}.png`)});
        await page.locator('.brain-tabs a[href="#today"]').click();
        await page.locator('#conversationList .conversation-digest').first().evaluate(node=>node.open=true);
        await page.locator('#conversationList .conversation-source').first().click();
        await page.waitForFunction(()=>document.querySelector('#recording-ui-sample')?.open);
        await page.waitForTimeout(1000);
        await page.locator('#recording-ui-sample audio').evaluate(audio=>{window.qaAudio=audio;});
        // Cloud/source hydration sends this same-day refresh after a tile opens.
        await page.evaluate(()=>document.getElementById('datePicker').dispatchEvent(new Event('change',{bubbles:true})));
        await page.waitForTimeout(700);
        assert(await page.locator('#recording-ui-sample').evaluate(card=>card.open),'source tile stays open after background hydration');
        assert(await page.locator('#recording-ui-sample audio').evaluate(audio=>audio===window.qaAudio),'refresh preserves the same native audio player');
        await page.locator('.brain-tabs a[href="#myActions"]').click();
        await page.locator('#actionsTab-ask').click();
        await page.locator('#askInput').fill('What did I decide today?');
        await page.locator('#askForm button[type="submit"]').click();
        await page.waitForFunction(()=>document.getElementById('askAnswer').textContent.toLowerCase().includes('prototype'));
        await page.locator('.brain-tabs a[href="#today"]').click();
        await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
        await page.screenshot({path:path.join(output,`workspace-${mode}-${width}.png`)});
        if(width===390){
          await page.evaluate(()=>{const focus=document.querySelector('.daily-focus');window.scrollTo({top:focus.getBoundingClientRect().top+scrollY-100,behavior:'instant'});});
          await page.screenshot({path:path.join(output,`workspace-focus-${mode}-${width}.png`)});
          await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
        }
        await page.screenshot({path:path.join(output,`sample-${mode}-${width}.png`),fullPage:true});
        await page.evaluate(async()=>{
          const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('dk-pendant-recordings');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
          const sample=await new Promise(resolve=>{const request=db.transaction('recordings').objectStore('recordings').get('ui-sample');request.onsuccess=()=>resolve(request.result)});
          sample.meeting.people=Array.from({length:14},(_,i)=>({name:'Person '+String(i+1).padStart(2,'0'),role:'Collaborator'}));
          await new Promise((resolve,reject)=>{const tx=db.transaction('recordings','readwrite'),store=tx.objectStore('recordings');store.put(sample);
            for(let i=1;i<=8;i++){const date=new Date();date.setDate(date.getDate()-i);store.put({...sample,id:'ui-older-'+i,name:'Earlier conversation '+i+(i===8?' · Zephyr':''),createdAt:date.toISOString()});}
            tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
          });db.close();
        });
        await page.reload();
        await page.waitForFunction(()=>document.getElementById('recordingsCount').textContent==='9'&&document.getElementById('peopleCount')?.textContent==='14');
        assert.equal(await page.locator('#glanceRecordings').innerText(),'1','Today metrics stay day-scoped');
        await page.locator('.brain-tabs a[href="#library"]').click();
        assert.equal(await page.locator('.recording-card:visible').count(),5,'all dates with pagination');
        const librarySearch=page.locator('#librarySearch');
        await librarySearch.fill('Zephyr');
        assert.equal(await page.locator('.recording-card:visible').count(),1);
        assert(await page.locator('#recording-ui-older-8').isVisible());
        assert.match(await page.locator('#librarySearchStatus').innerText(),/1 matching recording$/);
        await librarySearch.fill('enclosure');
        assert.match(await page.locator('#librarySearchStatus').innerText(),/9 matching recordings/,'search includes transcript and summary');
        await page.locator('#showMoreRecordingsButton').click();
        assert.equal(await page.locator('.recording-card:visible').count(),9);
        await librarySearch.fill('no-such-discussion');
        assert.equal(await page.locator('.recording-card:visible').count(),0);
        assert.match(await page.locator('#librarySearchStatus').innerText(),/No matching recordings/);
        await page.evaluate(()=>SynapProvenance.openSource('ui-older-8',0));
        await page.waitForFunction(()=>document.getElementById('recording-ui-older-8')?.open);
        assert.equal(await librarySearch.inputValue(),'','source navigation clears a search that would hide the source');
        assert(await page.locator('#recording-ui-older-8 .recording-content').isVisible());
        await page.evaluate(()=>{const picker=document.getElementById('datePicker');picker.value=new Date().toLocaleDateString('en-CA');picker.dispatchEvent(new Event('change',{bubbles:true}));});
        await librarySearch.fill('Zephyr');
        await page.locator('[data-library-scope="day"]').click();
        await page.waitForFunction(()=>document.getElementById('recordingsCount').textContent==='1');
        assert.match(await page.locator('#librarySearchStatus').innerText(),/No matching recordings/,'date and query filters combine');
        await page.locator('#clearLibrarySearch').click();
        assert.equal(await page.locator('.recording-card:visible').count(),1);
        await page.locator('[data-library-scope="all"]').click();
        await page.waitForFunction(()=>document.getElementById('recordingsCount').textContent==='9');
        await page.locator('.brain-tabs a[href="#library"]').click();
        await page.screenshot({path:path.join(output,`workspace-library-${mode}-${width}.png`)});
        await page.locator('[data-library-scope="day"]').click();
        await page.waitForFunction(()=>document.getElementById('recordingsCount').textContent==='1');
        await page.locator('[data-library-scope="all"]').click();
        await page.waitForFunction(()=>document.getElementById('recordingsCount').textContent==='9');
        await page.evaluate(()=>SynapProvenance.openSource('ui-older-8',0));
        await page.waitForFunction(()=>document.getElementById('recording-ui-older-8')?.open);
        await page.waitForTimeout(1000);
        assert(await page.locator('#recording-ui-older-8 .recording-content').isVisible(),'source beyond first page is revealed');
        const cardRect=await page.locator('#recording-ui-older-8').boundingBox();
        assert(cardRect.y<800&&cardRect.y+cardRect.height>100,'source card is actually in the viewport');
        await page.screenshot({path:path.join(output,`library-${mode}-${width}.png`)});
        await page.evaluate(()=>{const date=new Date();const picker=document.getElementById('datePicker');picker.value=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');picker.dispatchEvent(new Event('change',{bubbles:true}));});
        await page.evaluate(()=>SynapCompactLayout.reveal('peopleMemory'));
        await page.locator('#peopleMemory').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('#peopleList .person-card').count(),3,'compact recent people preview');
        assert((await page.locator('#peopleMemory').boundingBox()).height<380,'People stays compact');
        await page.screenshot({path:path.join(output,`people-${mode}-${width}.png`)});
        await page.evaluate(()=>SynapCompactLayout.reveal('peopleMemory'));
        await page.locator('#peopleBrowseToggle').click();
        assert.equal(await page.locator('#peopleList .person-card').count(),14);
        assert((await page.locator('#myActionsContent').boundingBox()).height<=300,'expanded people stay inside the shared content area');
        assert(await page.locator('#myActionsContent').evaluate(node=>node.scrollHeight>node.clientHeight),'all people remain reachable by scrolling the shared area');
        await page.locator('#peopleSearch input').fill('Person 14');
        assert.equal(await page.locator('#peopleList .person-card').count(),1);
        await page.locator('#peopleList .person-card').click();
        assert.equal(await page.locator('#askInput').inputValue(),'Person 14','person opens grounded recall');
        assert(await page.locator('#askInput').isVisible(),'person recall selects the Ask tab');
        await page.locator('#actionsTab-peopleMemory').click();
        await page.locator('#peopleBrowseToggle').click();
        assert.equal(await page.locator('#peopleList .person-card').count(),3);
        // Canonical People uses the same compact layout, including real name controls.
        await page.evaluate(async()=>{
          window.SynapAuth={isSignedIn:()=>true};
          window.qaPeople=Array.from({length:14},(_,i)=>({person_id:'person-'+i,name:'Person '+String(i+1).padStart(2,'0'),role:'Collaborator',conversation_count:2,confirmed_by_user:i===0}));
          window.SynapBackend={...window.SynapBackend,people:async()=>({people:window.qaPeople.map(person=>({...person}))}),followUps:async()=>({follow_ups:[]}),
            renamePerson:async(id,name)=>Object.assign(window.qaPeople.find(person=>person.person_id===id),{name,confirmed_by_user:true}),
            confirmPerson:async(id)=>Object.assign(window.qaPeople.find(person=>person.person_id===id),{confirmed_by_user:true})};
          SynapPeopleConfirmUI.invalidate();await SynapInteractionSurfaces.refresh(true);
        });
        await page.waitForFunction(()=>document.querySelectorAll('#peopleList .person-verify').length===3);
        assert.equal(await page.locator('#peopleList .person-card').count(),3);
        assert((await page.locator('#peopleMemory').boundingBox()).height<380,'canonical People controls stay compact');
        await page.locator('#peopleMemory').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(output,`people-canonical-${mode}-${width}.png`)});
        const manage=page.locator('#peopleList .person-management').first();
        await manage.locator('summary').click();
        await manage.locator('[data-action="rename"]').click();
        assert(await manage.locator('input[aria-label="Correct this person’s name"]').isVisible(),'name editor remains available');
        await manage.locator('input').fill('Alex Example');
        await manage.locator('button[type="submit"]').click();
        await page.waitForFunction(()=>document.querySelector('#peopleList .person-card strong').textContent==='Alex Example');
        await manage.locator('summary').click();
        const unconfirmed=page.locator('#peopleList .person-management').nth(1);
        await unconfirmed.locator('summary').click();
        await unconfirmed.locator('[data-action="confirm"]').click();
        await page.waitForFunction(()=>document.querySelectorAll('#peopleList .person-confirmed').length===2);
        await unconfirmed.locator('summary').click();
        console.log(`PASS feedback/${mode}/${width}: themed pixels, source tiles, refresh identity, date scope, pagination, compact/searchable People`);
        console.log(`PASS populated/${width}: local storage, search, playback, WAV export, grounded local Ask`);
      }
      // Presentation-only state simulation. No recording/BLE session is started.
      await page.evaluate(() => { document.body.dataset.state='recording'; document.getElementById('stopButton').disabled=false; });
      assert(await page.locator('#stopButton').isVisible());
      assert(!(await page.locator('#startButton').isVisible()));
      await page.evaluate(() => { document.body.dataset.state='disconnected'; });
      assert.deepEqual(errors,[],`${mode}/${width}: runtime errors`);
      console.log(`PASS ${mode}/${width}: layout, navigation, settings, hidden OTA and recorder states`);
      await context.close();
    }
    console.log(`Screenshots: ${output}`);
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode=1; }).finally(() => server.close());
