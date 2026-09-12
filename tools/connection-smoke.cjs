/* Full PWA recording/reconnect check with a simulated pendant and local PCM.
 * Requires Playwright and SYNAP_CHROMIUM_PATH. External requests are blocked. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=process.env.SYNAP_UI_ROOT||path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data)})});

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,executablePath:process.env.SYNAP_CHROMIUM_PATH,args:['--no-sandbox']});
 try{
 const context=await browser.newContext({viewport:{width:390,height:900}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await context.addInitScript(require('./support/pendant-fixture.cjs'));
 const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 if(process.env.SYNAP_RECOVERY_FIXTURE==='1'){
   await page.goto(origin+'/?buffered');await page.waitForFunction(()=>document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'));
   await page.locator('#headerPendantStatus').click();await page.waitForFunction(()=>document.body.dataset.state==='idle'&&bleFixture.armed);
   await page.evaluate(()=>localStorage.setItem('dk-pendant-auto-reconnect','on'));
   await page.locator('#headerCaptureToggle').click();await page.waitForFunction(()=>bleFixture.captured>=12);
   await page.evaluate(()=>{bleFixture.hide();bleFixture.disconnect()});await page.waitForTimeout(1200);
   const offline=await page.evaluate(()=>bleFixture.captured);assert(offline>=30,'capture continues while disconnected');
   await page.evaluate(()=>bleFixture.show());await page.waitForFunction(()=>document.body.dataset.state==='recording'&&!bleFixture.recoveryWaiting);
   // Stop before replay catches up; received frames must still be drained and sealed.
   await page.locator('#headerCaptureToggle').click();await page.waitForFunction(()=>document.body.dataset.state==='idle');
   const captured=await page.evaluate(()=>bleFixture.captured);
   const stored=await page.evaluate(async()=>{const store=new DKAudioStore();return (await store.all('recordings'))[0]});
   assert.equal(stored.stats.completeFrames,captured,'every captured offline and live frame is saved');
   assert.equal(stored.stats.missingFrames,0);assert.equal(stored.durationMs,captured*50);
   assert.equal(await page.evaluate(()=>bleFixture.starts),1,'recovery never starts a second firmware recording');
   assert.deepEqual(errors,[]);console.log('PASS buffered recovery: offline capture, same timeline, no START and stop drains queued audio');
   for(const mode of ['after','before','expired']){
     await page.waitForFunction(()=>!document.body.hasAttribute('data-auto-reconnecting'));
     const previous=await page.evaluate(async()=>({ids:(await new DKAudioStore().all('recordings')).map(r=>r.id),starts:bleFixture.starts}));
     await page.locator('#headerCaptureToggle').click();await page.waitForFunction(starts=>document.body.dataset.state==='recording'&&bleFixture.starts===starts+1&&bleFixture.captured>=12,previous.starts);
     await page.evaluate(()=>{bleFixture.holdReplay(true);bleFixture.hide();bleFixture.disconnect()});await page.waitForTimeout(850);
     await page.evaluate(()=>bleFixture.show());await page.waitForFunction(()=>document.body.dataset.state==='recording'&&!bleFixture.recoveryWaiting);
     await page.evaluate(mode=>bleFixture.interruptNextStop(mode==='before'?'before':'after'),mode);
     await page.locator('#headerCaptureToggle').click();
     await page.waitForFunction(()=>document.body.dataset.state==='disconnected'&&document.body.dataset.recordingInterrupted==='true');
     const stoppedAt=await page.evaluate(()=>bleFixture.captured);await page.waitForTimeout(250);
     if(mode!=='before')assert.equal(await page.evaluate(()=>bleFixture.captured),stoppedAt,'acknowledged Stop keeps the microphone off while disconnected');
     const pending=await page.evaluate(async ids=>(await new DKAudioStore().all('recordings')).find(r=>!ids.includes(r.id)),previous.ids);
     assert.equal(pending.status,'recording','the journal is not sealed while remaining audio can be recovered');
     await page.evaluate(mode=>{bleFixture.holdReplay(false);if(mode==='expired')bleFixture.expireBuffer();bleFixture.show()},mode);
     await page.waitForFunction(()=>document.body.dataset.state==='idle'&&document.body.dataset.recordingInterrupted==='false');
     const saved=await page.evaluate(async ids=>(await new DKAudioStore().all('recordings')).find(r=>!ids.includes(r.id)),previous.ids);
     assert.equal(saved.status,'saved');assert(saved.durationMs>0);
     if(mode!=='expired'){assert.equal(saved.stats.completeFrames,await page.evaluate(()=>bleFixture.captured));assert.equal(saved.stats.missingFrames,0)}
     assert.equal(await page.evaluate(()=>bleFixture.starts),previous.starts+1,'reconnecting after Stop must never issue START');
     assert.deepEqual(errors,[]);console.log('PASS buffered Stop/'+mode+': Stop intent survives reconnect and the same journal is saved without another START');
   }
   await page.waitForFunction(()=>!document.body.hasAttribute('data-auto-reconnecting'));
   const previous=await page.evaluate(async()=>({ids:(await new DKAudioStore().all('recordings')).map(r=>r.id),starts:bleFixture.starts}));
   await page.locator('#headerCaptureToggle').click();await page.waitForFunction(starts=>document.body.dataset.state==='recording'&&bleFixture.starts===starts+1&&bleFixture.captured>=12,previous.starts);
   await page.evaluate(()=>{
     const put=IDBObjectStore.prototype.put;
     window.qaQualityAborts=0;
     IDBObjectStore.prototype.put=function(value,...rest){
       if(this.name==='recordings'&&value.audioQuality&&!qaQualityAborts){qaQualityAborts++;this.transaction.abort();return}
       return put.call(this,value,...rest);
     };
     bleFixture.hide();bleFixture.disconnect();bleFixture.invalidRecoveryOnce();bleFixture.show();
   });
   await page.waitForFunction(()=>document.querySelector('#diagnosticsLog').textContent.includes('recovery information was incomplete'));
   await page.waitForFunction(()=>document.body.dataset.state==='recording'&&!document.body.hasAttribute('data-auto-reconnecting'),null,{timeout:15000});
   await page.locator('#headerCaptureToggle').click();await page.waitForFunction(()=>document.body.dataset.state==='idle');
   const retained=await page.evaluate(async ids=>(await new DKAudioStore().all('recordings')).find(r=>!ids.includes(r.id)),previous.ids);
   assert.equal(await page.evaluate(()=>qaQualityAborts),1);assert.equal(retained.status,'saved');
   assert.equal(retained.stats.completeFrames,await page.evaluate(()=>bleFixture.captured));assert.equal(retained.stats.missingFrames,0);
   assert.equal(await page.evaluate(()=>bleFixture.starts),previous.starts+1);assert.deepEqual(errors,[]);
   console.log('PASS incomplete recovery reply retries safely; an optional quality transaction failure cannot prevent sealing audio');
   await context.close();return;
 }
 await page.clock.install({time:new Date('2026-09-11T10:00:00Z')});await page.goto(origin);
 await page.waitForFunction(()=>window.SynapCompactLayout&&document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'));await page.locator('#headerPendantStatus').click();
 await page.waitForFunction(()=>document.body.dataset.state==='idle');
 await page.evaluate(()=>localStorage.setItem('dk-pendant-auto-reconnect','on'));
 await page.waitForFunction(()=>!document.body.hasAttribute('data-auto-reconnecting'));
 const idleReads=await page.evaluate(()=>bleFixture.statusReads);
 await page.evaluate(()=>{bleFixture.hide();bleFixture.show()});await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>bleFixture.statusReads),idleReads,'foregrounding an idle link does not probe native GATT');
 assert.equal(await page.evaluate(()=>bleFixture.appDisconnects),0);

 await page.locator('#headerCaptureToggle').click();await page.waitForFunction(()=>document.body.dataset.state==='recording');
 // A real model Worker may now run during rolling capture. Exercise the same
 // automatic entry point while BLE packets continue arriving on the main thread.
 const {wav,fixture}=require('./audio-enhancement-fixtures.cjs');
 await page.evaluate(bytes=>{window.qaAudioPreparation=SynapAudioEnhancement.prepareForUpload(new Blob([new Uint8Array(bytes)],{type:'audio/wav'})).then(copy=>copy.size)},[...wav(fixture(16000,3))]);
 const records=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('dk-pendant-recordings');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,read=db.transaction('recordings').objectStore('recordings').getAll();read.onsuccess=()=>{db.close();resolve(read.result.map(x=>({id:x.id,status:x.status,sizeBytes:x.sizeBytes,durationMs:x.durationMs,rememberMarkers:x.rememberMarkers})))}}}));
 await page.waitForTimeout(800);await page.locator('#markMoment').click();fs.mkdirSync('/tmp/synap-moments-qa',{recursive:true});await page.screenshot({path:'/tmp/synap-moments-qa/recording-light.png'});await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'synap-appearance',newValue:'dark'}))); await page.screenshot({path:'/tmp/synap-moments-qa/recording-dark.png'});await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'synap-appearance',newValue:'light'}))); await page.waitForFunction(()=>document.querySelector('#momentFeedback').textContent==='Moment saved');const first=await records();assert.equal(first[0].rememberMarkers.length,1);assert(first[0].rememberMarkers[0].offsetMs>0);assert.equal(first.length,1);
 await page.evaluate(()=>{bleFixture.hideOnNextConnect();bleFixture.disconnect()});
 await page.waitForFunction(()=>document.body.dataset.recordingInterrupted==='true');
 await page.waitForFunction(()=>document.body.dataset.state==='recording'&&document.body.dataset.recordingInterrupted==='false',{},{timeout:15000});
 assert.equal(await page.evaluate(()=>bleFixture.appDisconnects),0,'native Bluetooth UI must not cancel recording reconnect');
 const readsBeforeForeground=await page.evaluate(()=>bleFixture.statusReads);
 await page.evaluate(()=>bleFixture.show());await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>bleFixture.statusReads),readsBeforeForeground,'foreground does not poll a live capture');
 await page.evaluate(()=>bleFixture.delayStatusRead());await page.waitForFunction(()=>bleFixture.readPending);
 await page.waitForFunction(()=>bleFixture.readError==='TimeoutError');
 assert.equal(await page.evaluate(()=>bleFixture.appDisconnects),0,'a delayed diagnostic read must not terminate arriving audio');
 assert.equal(await page.evaluate(()=>document.body.dataset.state),'recording');
 await page.evaluate(()=>bleFixture.finishRead());await page.waitForTimeout(100);
 await page.locator('.brain-tabs a[href="#today"]').click();
 await page.locator('[data-day-step="-1"]').click();
 await page.locator('.brain-tabs a[href="#library"]').click();
 await page.locator('.brain-tabs a[href="#myActions"]').click();
 for(const id of ['dailyFocus','followupInbox','peopleMemory','ask'])await page.locator('#actionsTab-'+id).click();
 assert.equal(await page.locator('#headerCaptureToggle').getAttribute('aria-label'),'Stop listening');
 await page.locator('.brain-tabs a[href="#today"]').click();
 assert.equal(await page.evaluate(()=>bleFixture.appDisconnects),0,'day and section browsing preserves capture');
 assert.equal(await page.evaluate(()=>qaAudioPreparation),96044,'local preprocessing completes during capture');
 await page.waitForTimeout(800);const resumed=await records();assert.equal(resumed.length,1);assert.equal(resumed[0].id,first[0].id);
 await page.locator('#settingsButton').click();await page.waitForFunction(()=>document.querySelector('#settingsDialog').open);
 await page.locator('#settingsDialog').evaluate(node=>node.scrollTop=500);
 assert.equal(await page.locator('#headerCaptureToggle').getAttribute('aria-label'),'Stop listening');
 await page.locator('#headerCaptureToggle').click();await page.waitForFunction(()=>document.body.dataset.state==='idle');
 assert(await page.locator('#settingsDialog').evaluate(node=>node.open),'header Stop keeps Settings open');
 await page.locator('#settingsButton').click();await page.waitForFunction(()=>!document.querySelector('#settingsDialog').open);
 const saved=await records();assert.equal(saved[0].rememberMarkers.length,1,'bookmark survives reconnect and saving');assert(!(await page.locator('#markMoment').isVisible()));assert.equal(await page.locator('.brain-tabs a').count(),4);assert.equal(await page.locator('#rememberThis').count(),0);assert(!(await page.locator('#capture').isVisible()));assert.equal(await page.evaluate(()=>SynapMoments.mark().then(()=>false,()=>true)),true,'idle marks are rejected');assert.equal(saved.length,1);assert.equal(saved[0].id,first[0].id);assert(saved[0].durationMs>=1200);
 assert.equal(await page.evaluate(()=>window.bleFixture.maximum),1);assert.deepEqual(errors,[]);
 await page.locator('.brain-tabs a[href="#library"]').click();await page.locator('#recording-'+saved[0].id+' > summary').click();await page.waitForFunction(()=>!!document.querySelector('.recording-moments button'));assert.equal(await page.locator('.recording-moments button').count(),1);await page.locator('.recording-moments button').click();await page.waitForFunction(()=>{const a=document.querySelector('.recording-content audio');return a&&!a.paused&&a.currentTime>0});await page.locator('.recording-content audio').evaluate(a=>a.pause());
 console.log('PASS: recording survives native UI visibility changes, a slow GATT reply, navigation and reconnect; header Stop saves from Settings with one journal and no overlapping GATT requests',saved[0]);

 const starts=await page.evaluate(()=>bleFixture.starts);
 const sleepPendant=async()=>{await page.waitForFunction(()=>document.body.dataset.eventChannel==='event');await page.evaluate(()=>bleFixture.sleep())};
 await page.reload();await page.waitForFunction(()=>document.body.dataset.state==='idle');
 assert.equal(await page.evaluate(()=>bleFixture.pickers),1,'reload reuses permission without a chooser');
 assert.equal(await page.evaluate(()=>bleFixture.starts),starts,'reload does not start recording');
 assert(!(await page.locator('#capture').isVisible()),'automatic recovery does not expose redundant controls');
 await sleepPendant();
 await page.waitForFunction(()=>SynapSleepStateGuard.locked&&document.body.dataset.state==='disconnected');
 const sleepingConnects=await page.evaluate(()=>bleFixture.connects);
 await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>bleFixture.connects),sleepingConnects,'no immediate reconnection during sleep transition');
 await page.clock.fastForward(6000);await page.waitForFunction(()=>bleFixture.watching);
 await page.evaluate(()=>bleFixture.wake());await page.waitForFunction(()=>document.body.dataset.state==='idle');
 assert.equal(await page.evaluate(()=>SynapSleepStateGuard.locked),false,'live service clears stale sleep lock');
 assert.equal(await page.evaluate(()=>bleFixture.pickers),1);
 console.log('PASS: reload restores the permitted pendant and a wake advertisement reconnects without another picker or START');

 await page.evaluate(()=>bleFixture.disableAdvertisements());await sleepPendant();
 await page.waitForFunction(()=>SynapSleepStateGuard.locked&&document.body.dataset.state==='disconnected');
 await page.clock.fastForward(6000);await page.waitForTimeout(200);
 const unavailableAttempts=await page.evaluate(()=>bleFixture.connects);
 await page.evaluate(()=>bleFixture.wake());
 // This is foreground polling: execute each timer at its deadline. fastForward
 // models a suspended page and can move an in-flight retry's timeout ahead of
 // the fixture's connection callback on older Chromium versions.
 await page.clock.runFor(31000);
 try{await page.waitForFunction(()=>document.body.dataset.state==='idle');}
 catch(error){
   console.error('Periodic wake recovery failed',await page.evaluate(()=>({state:document.body.dataset.state,
     connects:bleFixture.connects,maximum:bleFixture.maximum,locked:SynapSleepStateGuard.locked,
     diagnostics:document.getElementById('diagnosticsLog').textContent})));
   throw error;
 }
 assert((await page.evaluate(()=>bleFixture.connects))>unavailableAttempts,'periodic recovery detects wake without advertisements');

 await sleepPendant();await page.waitForFunction(()=>SynapSleepStateGuard.locked);
 await page.locator('#settingsButton').click();await page.locator('#autoReconnectInput').uncheck();
 const disabledConnects=await page.evaluate(()=>bleFixture.connects);
 await page.evaluate(()=>bleFixture.wake());await page.clock.fastForward(31000);await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>bleFixture.connects),disabledConnects,'off preference is respected during sleep/wake');
 await page.locator('#autoReconnectInput').check();await page.waitForFunction(()=>document.body.dataset.state==='idle');
 await page.locator('#closeSettingsButton').click();
 assert.equal(await page.evaluate(()=>bleFixture.starts),starts);
 console.log('PASS: periodic fallback recovers a later wake and respects the reconnect preference without changing recording state');

 await sleepPendant();await page.waitForFunction(()=>SynapSleepStateGuard.locked);
 // The fixture reappears on reload, like a pendant woken while this page was closed.
 await page.reload();await page.waitForFunction(()=>document.body.dataset.state==='idle');
 assert.equal(await page.evaluate(()=>SynapSleepStateGuard.locked),false);
 assert.equal(await page.evaluate(()=>bleFixture.pickers),1,'persisted sleep state cannot block reload recovery');
 assert.equal(await page.evaluate(()=>bleFixture.starts),starts);
 console.log('PASS: a stale sleep flag from the previous page clears after reload connects to the awake pendant');

 await page.goto(origin+'/?noRestore=1');await page.waitForFunction(()=>window.SynapCompactLayout&&document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'));
 await page.locator('.brain-tabs a[href="#today"]').click();
 await page.waitForFunction(()=>document.querySelector('#reconnectStatus').textContent.includes('tap on Connect'));
 assert.equal(await page.evaluate(()=>bleFixture.pickers),1,'unsupported restore never prompts automatically');
 await page.locator('#settingsButton').click();assert(await page.locator('#reconnectStatus').isVisible());await page.locator('#settingsButton').click();
 await page.locator('#headerPendantStatus').click();await page.waitForFunction(()=>document.body.dataset.state==='idle');
 assert.equal(await page.evaluate(()=>bleFixture.pickers),2,'manual connection remains usable on limited browsers');
 assert.deepEqual(errors,[]);
 console.log('PASS: browsers without getDevices show an actionable hint and retain manual connection');

 await page.evaluate(()=>localStorage.setItem('dk-pendant-auto-reconnect','off'));
 await page.locator('#headerCaptureToggle').click();await page.waitForFunction(()=>document.body.dataset.state==='recording');
 await page.waitForTimeout(400);await page.evaluate(()=>bleFixture.delayStatusRead());
 await page.waitForFunction(()=>bleFixture.readError==='TimeoutError');
 await page.locator('#headerCaptureToggle').click();await page.waitForFunction(()=>document.body.dataset.state==='disconnected');
 await page.waitForFunction(()=>document.querySelector('#diagnosticsLog').textContent.includes('Recording stop was not acknowledged'));
 await page.evaluate(()=>bleFixture.finishRead());
 const stopped=await records();assert.equal(stopped.length,2);assert(stopped.every(r=>r.status==='saved'&&r.durationMs>0));
 assert.equal(await page.evaluate(()=>bleFixture.maximum),1);assert.deepEqual(errors,[]);
 console.log('PASS: Stop remains bounded when a native read never replies; the app disconnects deliberately and saves received audio');
 await page.locator('#headerPendantStatus').click();await page.waitForFunction(()=>document.body.dataset.state==='idle'&&!document.body.hasAttribute('data-auto-reconnecting'));
 const nativeConnects=await page.evaluate(()=>bleFixture.connects);
 await page.evaluate(()=>{localStorage.setItem('dk-pendant-auto-reconnect','on');sessionStorage.setItem('qa-retain-link','1')});
 await page.goto(origin);await page.waitForFunction(()=>document.body.dataset.state==='idle'&&!document.body.hasAttribute('data-auto-reconnecting'));
 assert.equal(await page.evaluate(()=>bleFixture.connects),nativeConnects,'a retained native link is adopted without connect()');
 assert.equal(await page.evaluate(()=>bleFixture.appDisconnects),0,'adopting a retained link never disconnects it');
 await page.waitForFunction(()=>document.body.dataset.eventChannel==='event');
 console.log('PASS: foreground preserves an idle link; reload adopts a retained native connection without disconnect/connect churn');
 await context.close();
 }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
