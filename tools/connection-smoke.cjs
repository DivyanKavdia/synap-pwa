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
 await context.addInitScript(()=>{
   if(!localStorage.getItem('dk-pendant-auto-reconnect'))localStorage.setItem('dk-pendant-auto-reconnect','off');
   localStorage.setItem('dk-pendant-settings',JSON.stringify({autoProcess:false,wakeLock:false}));
   let state=1,sequence=0,audioTimer=null,inFlight=0,maxInFlight=0,present=true,watching=false;
   let visibility='visible',hideOnConnect=false,appDisconnects=0,statusReads=0,holdRead=false,releaseRead=null,readError=null;
   Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
   function setVisibility(value){visibility=value;document.dispatchEvent(new Event('visibilitychange'))}
   const count=key=>Number(sessionStorage.getItem(key)||0);
   const increment=key=>sessionStorage.setItem(key,String(count(key)+1));
   const uuid=n=>'4fa123'+n+'-0000-1000-8000-00805f9b34fb';
   const status=()=>{const v=new DataView(new ArrayBuffer(16));v.setUint8(0,0x5a);v.setUint8(1,2);v.setUint8(2,state);v.setUint16(4,512,true);v.setUint16(6,509,true);v.setUint8(8,4);v.setUint8(9,8);v.setUint16(10,16000,true);v.setUint16(12,800,true);v.setUint16(14,400,true);return v};
   async function operation(fn){inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);if(inFlight>1)throw Error('Overlapping GATT requests');try{await new Promise(r=>setTimeout(r,5));return await fn()}finally{inFlight--}}
   class Characteristic extends EventTarget{
     constructor(id){super();this.id=id;this.properties={write:true,read:true,notify:true};this.value=null}
     startNotifications(){return operation(()=>this)}
     readValue(){return operation(async()=>{if(this.id===uuid('47')){statusReads++;if(holdRead){holdRead=false;await new Promise(resolve=>{releaseRead=resolve})}return status()}return this.id===uuid('4c')?new DataView(new TextEncoder().encode('SYNAP-ABCDEF123456').buffer):new DataView(new Uint8Array([0xe2,1,1,0,0x82,4]).buffer)})}
     writeValueWithResponse(value){return operation(()=>{if(value[0]===1){increment('qa-starts');state=2;sequence=0;clearInterval(audioTimer);audioTimer=setInterval(frame,50)}if(value[0]===0){state=1;clearInterval(audioTimer)}this.value=status();this.dispatchEvent(new Event('characteristicvaluechanged'))})}
   }
   const audio=new Characteristic(uuid('46')),control=new Characteristic(uuid('47'));
   const chars=new Map([[uuid('46'),audio],[uuid('47'),control],[uuid('4c'),new Characteristic(uuid('4c'))],[uuid('4e'),new Characteristic(uuid('4e'))]]);
   const service={getCharacteristic:id=>operation(()=>{if(!chars.has(id))throw new DOMException('No optional characteristic','NotFoundError');return chars.get(id)})};
   const device=new EventTarget();device.id='fixture-device';device.name='synap';
   function loseLink(){const wasConnected=device.gatt.connected;device.gatt.connected=false;clearInterval(audioTimer);if(wasConnected)device.dispatchEvent(new Event('gattserverdisconnected'))}
   device.gatt={connected:sessionStorage.getItem('qa-retain-link')==='1',connect(){increment('qa-connects');return operation(()=>{if(!present)throw new DOMException('Pendant is asleep','NetworkError');this.connected=true;state=1;if(hideOnConnect){hideOnConnect=false;setVisibility('hidden')}return this})},getPrimaryService(){return operation(()=>service)},disconnect(){appDisconnects++;loseLink()}};
   device.watchAdvertisements=async({signal})=>{watching=true;signal.addEventListener('abort',()=>{watching=false},{once:true})};
   function frame(){for(let chunk=0;chunk<4;chunk++){const v=new DataView(new ArrayBuffer(408));v.setUint8(0,0xa5);v.setUint8(1,2);v.setUint16(2,sequence,true);v.setUint8(4,chunk);v.setUint8(5,4);v.setUint16(6,400,true);audio.value=v;audio.dispatchEvent(new Event('characteristicvaluechanged'))}sequence=(sequence+1)&65535}
   const bluetooth=new EventTarget();bluetooth.requestDevice=async()=>{increment('qa-pickers');sessionStorage.setItem('qa-permitted','1');return device};
   if(!location.search.includes('noRestore'))bluetooth.getDevices=async()=>sessionStorage.getItem('qa-permitted')?[device]:[];
   Object.defineProperty(navigator,'bluetooth',{configurable:true,value:bluetooth});
   window.bleFixture={disconnect:loseLink,get maximum(){return maxInFlight},get watching(){return watching},
     get appDisconnects(){return appDisconnects},get statusReads(){return statusReads},get readError(){return readError},get readPending(){return Boolean(releaseRead)},
     hideOnNextConnect(){hideOnConnect=true},show:()=>setVisibility('visible'),hide:()=>setVisibility('hidden'),
     delayStatusRead(){holdRead=true;readError=null;SynapDevices.connection.queue(()=>control.readValue(),'Delayed diagnostic read').catch(error=>{readError=error.name})},
     finishRead(){releaseRead?.();releaseRead=null},
     get connects(){return count('qa-connects')},get pickers(){return count('qa-pickers')},get starts(){return count('qa-starts')},
     disableAdvertisements(){delete device.watchAdvertisements},
     sleep(){const events=chars.get(uuid('4e'));events.value=new DataView(new Uint8Array([0xe2,1,3,1,0x82,4]).buffer);events.dispatchEvent(new Event('characteristicvaluechanged'));present=false;loseLink()},
     wake(){present=true;if(watching){const event=new Event('advertisementreceived');event.device=device;device.dispatchEvent(event)}}
   };
 });
 const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
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
 await page.clock.fastForward(31000);await page.waitForFunction(()=>document.body.dataset.state==='idle');
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
