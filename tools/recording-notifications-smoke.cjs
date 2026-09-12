/* Real PWA + service worker + IndexedDB, with simulated pendant and OS notifications.
 * Notification taps are delivered through the worker's production action path.
 * Physical Android/iOS OS surfaces still require device validation. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data)});
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.SYNAP_CHROMIUM_PATH,args:['--no-sandbox']});
  try{
    const context=await browser.newContext({viewport:{width:390,height:900},permissions:['notifications']});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await context.addInitScript(require('./support/pendant-fixture.cjs'));
    // Headless Chromium has no OS notification center and reports zero actions.
    // Emulate that display boundary while preserving the real worker/page IPC.
    await context.addInitScript(()=>{
      Object.defineProperty(Notification,'maxActions',{value:2,configurable:true});
      Object.defineProperty(Notification,'permission',{value:'granted',configurable:true});
    });
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
    await page.goto(origin);
    await page.waitForFunction(()=>document.body.dataset.startup==='ready' && navigator.serviceWorker.controller);
    const worker=context.serviceWorkers()[0];assert(worker);
    await worker.evaluate(()=>{
      Object.defineProperty(Notification,'maxActions',{value:2,configurable:true});
      const entries=new Map();
      self.registration.showNotification=async(title,options)=>{
        const entry={title,...options,close(){if(entries.get(options.tag)===entry)entries.delete(options.tag)}};
        entries.set(options.tag,entry);
      };
      self.registration.getNotifications=async()=>[...entries.values()];
    });
    const notifications=()=>worker.evaluate(async()=>(await self.registration.getNotifications({tag:'synap-recording'}))
      .map(n=>({title:n.title,data:n.data,actions:n.actions})));
    async function waitForNotifications(count){
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){if((await notifications()).length===count)return;await new Promise(resolve=>setTimeout(resolve,50))}
      throw Error('Notification count did not become '+count);
    }
    const act=(action,sessionId)=>worker.evaluate(async({action,sessionId})=>{
      const notification=(await self.registration.getNotifications({tag:'synap-recording'}))[0];
      const owner=await self.clients.get(notification.data.ownerClientId);
      return sendRecordingAction(owner,{data:{...notification.data,...(sessionId?{sessionId}:{})}},action);
    },{action,sessionId});
    await page.locator('#settingsButton').click();
    assert.equal(await page.locator('#recordingNotificationInput').isEnabled(),true,
      JSON.stringify(await page.evaluate(()=>({capabilities:SynapRecordingNotifications.capabilities(),hint:document.getElementById('recordingNotificationHint').textContent,errors:document.getElementById('diagnosticsLog').textContent.slice(-400)}))));
    await page.locator('#recordingNotificationInput').check();
    await page.locator('#settingsButton').click();
    assert.equal((await notifications()).length,0,'enabling notifications cannot pretend recording has begun');
    await page.locator('#headerPendantStatus').click();await page.waitForFunction(()=>document.body.dataset.state==='idle');
    await page.locator('#headerCaptureToggle').click();
    await page.waitForFunction(()=>document.body.dataset.state==='recording');
    await waitForNotifications(1);
    const first=(await notifications())[0];
    assert.equal(first.title,'Synap is recording');
    assert.deepEqual(first.actions.map(a=>a.action),['stop','mark']);
    await page.waitForFunction(()=>bleFixture.captured>=8);
    const started=await page.evaluate(()=>bleFixture.starts);
    assert.equal(await act('mark'),true);
    await page.waitForFunction(async()=>{
      const recordings=await new DKAudioStore().all('recordings');
      return recordings.some(r=>r.status==='recording' && r.rememberMarkers?.length===1);
    });
    assert.equal(await act('stop'),true);
    await page.waitForFunction(()=>document.body.dataset.state==='idle');await waitForNotifications(0);
    const saved=await page.evaluate(()=>new DKAudioStore().all('recordings'));
    assert.equal(saved.length,1);assert.equal(saved[0].status,'saved');assert(saved[0].durationMs>0);
    assert.equal(saved[0].rememberMarkers.length,1);
    assert.equal(await page.evaluate(()=>bleFixture.starts),started);
    await page.locator('#headerCaptureToggle').click();
    await waitForNotifications(1);
    assert.equal(await act('stop',first.data.sessionId),false,'old take cannot stop the next take');
    assert.equal(await page.evaluate(()=>document.body.dataset.state),'recording');
    assert.equal(await act('stop'),true);
    await page.waitForFunction(()=>document.body.dataset.state==='idle');
    await page.locator('#settingsButton').click();
    await page.locator('#recordingNotificationInput').uncheck();
    await page.locator('#settingsButton').click();
    await page.locator('#headerCaptureToggle').click();await page.waitForFunction(()=>document.body.dataset.state==='recording');
    await page.evaluate(()=>SynapRecordingNotifications.sync(true));
    assert.equal((await notifications()).length,0,'off preference leaves recording usable without a notification');
    await page.locator('#headerCaptureToggle').click();await page.waitForFunction(()=>document.body.dataset.state==='idle');
    assert.deepEqual(errors,[]);
    console.log('PASS: real worker notification, durable marked moment, Stop/save/cleanup, stale-take rejection and opt-out during live BLE capture.');
    await context.close();
  }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
