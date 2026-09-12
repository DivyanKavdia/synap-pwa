/* Real application handlers, storage and OTA protocol; only the pendant and
 * public release responses are simulated. Exercise mobile taps, not DOM clicks. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=process.env.SYNAP_UI_ROOT||path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(name==='/'?'/index.html':name));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'}).end(data)})});
const releaseBase='https://raw.githubusercontent.com/DivyanKavdia/synap-firmware/ota-releases/';
function release(target){
  const c3=target.includes('c3'),prefix=c3?'targets/'+target+'/':'';
  const identity='SYNAP-FW:'+target+':1.0.0:1201',binary=Buffer.alloc(8192);
  binary[0]=0xe9;binary.writeUInt16LE(c3?5:9,12);binary.writeUInt32LE(0xabcd5432,32);
  binary.write(c3?'SYNAP-ESP32C3-OTA-ID-V3':'SYNAP-ESP32S3-OTA-ID-V3',80);binary.write(identity,128);
  const sha256=crypto.createHash('sha256').update(binary).digest('hex');
  return{binary,manifest:{schema:3,version:'1.0.0',build:1201,target,protocol:3,chip:c3?5:9,flashBytes:4194304,psramBytes:c3?0:2097152,partition:'default',size:binary.length,sha256,commit:'a'.repeat(40),identity,url:releaseBase+prefix+'builds/1201-'+sha256+'.bin',channel:'production',provenance:{provider:'github-actions',repository:'DivyanKavdia/synap-firmware',workflow:'.github/workflows/firmware.yml'}}};
}
const releases=['esp32s3-fh4r2-qspi-4m','esp32c3-supermini-4m'].map(release);
const catalog={schema:1,build:1201,primary:releases[0].manifest.target,channel:'production',targets:Object.fromEntries(releases.map(({manifest:m},i)=>[m.target,i?'targets/'+m.target+'/latest.json':'latest.json']))};
const waitReady=page=>page.waitForFunction(()=>document.body.dataset.startup==='ready');
const waitState=(page,state)=>page.waitForFunction(state=>document.body.dataset.state===state,state);

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.SYNAP_CHROMIUM_PATH,args:['--no-sandbox']});
  try{
    async function setup(query='',fault){
      const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,serviceWorkers:'block'});
      let releaseGate=null,releaseWait=null;
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.origin===origin)return route.continue();
        if(url.href.startsWith(releaseBase)){
          if(url.pathname.endsWith('/latest.json')&&releaseWait)await releaseWait;
          const r=releases.find(r=>url.href.startsWith(r.manifest.url));
          if(r)return route.fulfill({contentType:'application/octet-stream',body:r.binary});
          if(url.pathname.endsWith('/targets.json'))return route.fulfill({json:catalog});
          if(url.pathname.endsWith('/latest.json'))return route.fulfill({json:releases[url.pathname.includes('/targets/')?1:0].manifest});
        }
        return route.abort();
      });
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      if(fault)await context.addInitScript(fault);
      const page=await context.newPage(),errors=[];page.setDefaultTimeout(12000);
      page.on('pageerror',error=>errors.push(error.message));
      // Embedded browsers may suppress native confirm. OTA must still be usable.
      await page.addInitScript(()=>{window.confirm=()=>false});
      await page.goto(origin+query);
      return{context,page,errors,holdReleases(){releaseWait=new Promise(resolve=>{releaseGate=resolve})},release(){releaseWait=null;releaseGate?.()}};
    }

    {
      const t=await setup('/',()=>{
        let Store;const gate=new Promise(resolve=>{window.qaFinishRecovery=resolve});
        Object.defineProperty(window,'DKAudioStore',{configurable:true,get:()=>Store,set(value){
          Store=value;const recover=Store.prototype.recover;
          Store.prototype.recover=async function(...args){window.qaRecoveryWaiting=true;await gate;return recover.apply(this,args)};
        }});
      }),{page}=t;
      await page.waitForFunction(()=>window.qaRecoveryWaiting);
      assert(await page.locator('#headerPendantStatus').isEnabled(),'Connect remains available while library recovery is pending');
      await page.locator('#settingsButton').tap();await page.locator('#connectButton').tap();await waitState(page,'idle');
      assert(await page.locator('#headerCaptureToggle').isDisabled(),'recording waits until storage recovery finishes');
      assert.equal(await page.evaluate(()=>bleFixture.connects),1);
      await page.evaluate(()=>qaFinishRecovery());await waitReady(page);await waitState(page,'idle');
      assert.equal(await page.evaluate(()=>bleFixture.connects),1,'finishing startup preserves the existing connection');
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'recording');
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'idle');
      assert.deepEqual(t.errors,[]);await t.context.close();console.log('PASS Connect works during library recovery; recording waits and the link stays connected');
    }

    {
      const t=await setup('/?lateBluetooth'),{page}=t;await waitReady(page);await waitState(page,'unsupported');
      assert(await page.locator('#headerPendantStatus').isEnabled(),'Bluetooth unavailability must not permanently disable Connect');
      await page.locator('#headerPendantStatus').tap();
      assert(await page.locator('#settingsDialog').evaluate(node=>node.open));
      assert.match(await page.locator('#reconnectStatus').textContent(),/Bluetooth access is not available/);
      assert(await page.locator('#reconnectStatus').isVisible(),'the connection explanation is visible inside Settings');
      await page.evaluate(()=>bleFixture.enableBluetooth());
      await page.locator('#connectButton').tap();await waitState(page,'idle');
      assert.equal(await page.evaluate(()=>bleFixture.pickers),1,'Connect uses Bluetooth that became available after startup');
      await page.locator('#connectButton').tap();await waitState(page,'disconnected');
      assert(await page.locator('#settingsDialog').evaluate(node=>node.open),'Disconnect leaves Settings open');
      await page.locator('#settingsButton').tap();
      await page.evaluate(()=>{window.qaSyntheticConnects=0;document.addEventListener('click',event=>{if(!event.isTrusted&&event.target.closest?.('#connectButton'))qaSyntheticConnects++},true)});
      await page.locator('#headerPendantStatus').tap();await waitState(page,'idle');
      assert.equal(await page.evaluate(()=>qaSyntheticConnects),0,'header Connect calls the action without a synthetic tap into a closed dialog');
      assert.equal(await page.evaluate(()=>bleFixture.starts),0,'Connect never silently starts recording');
      assert.deepEqual(t.errors,[]);await t.context.close();console.log('PASS delayed Bluetooth, direct Settings/header Connect, Disconnect and visible permission feedback');
    }

    for(const errorName of ['NotFoundError','NotAllowedError']){
      const t=await setup(),{page}=t;await waitReady(page);
      await page.locator('#settingsButton').tap();
      await page.evaluate(name=>bleFixture.rejectNextPicker(name,'Bluetooth permission was denied'),errorName);
      await page.locator('#connectButton').tap();
      await page.waitForFunction(()=>bleFixture.pickers===1&&document.body.dataset.state==='disconnected');
      assert(await page.locator('#reconnectStatus').isVisible());
      assert(await page.locator('#connectButton').isEnabled());
      await page.locator('#connectButton').tap();await waitState(page,'idle');
      assert.equal(await page.evaluate(()=>bleFixture.pickers),2);
      assert.deepEqual(t.errors,[]);await t.context.close();console.log('PASS Connect recovers after '+errorName+' without a reload');
    }

    for(const c3 of [false,true]){
      const t=await setup('/?ota'+(c3?'&c3':'')),{page}=t;await waitReady(page);
      assert(await page.locator('#headerCaptureToggle').isEnabled(),'offline microphone offers connect and record');
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'recording');
      assert.equal(await page.evaluate(()=>bleFixture.starts),1,'one tap connects and starts exactly once');
      await page.locator('#settingsButton').tap();
      await page.locator('#otaReleaseCheck').tap();
      assert.match(await page.locator('#otaStatus').textContent(),/Stop and save/);
      assert(await page.locator('#settingsDialog').evaluate(node=>node.open),'blocked check keeps Settings open');
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'idle');
      assert(await page.locator('#settingsDialog').evaluate(node=>node.open),'header Stop works inside Settings');
      const saved=await page.evaluate(async()=>(await new DKAudioStore().all('recordings'))[0]);
      assert.equal(saved.status,'saved');assert(saved.durationMs>0,'Stop persists actual received audio');
      await page.locator('#otaReleaseCheck').tap();await page.waitForFunction(()=>!document.getElementById('otaLatest').hidden);
      // Starting a fresh background check must not turn a visible Update into a dead control.
      t.holdReleases();await page.locator('#otaReleaseCheck').tap();
      await page.waitForFunction(()=>document.getElementById('otaStatus').textContent==='Checking…');
      assert(await page.locator('#otaLatest').isEnabled());
      await page.locator('#otaLatest').tap();
      await page.waitForFunction(()=>document.getElementById('otaStatus').textContent.includes('before installing'));
      await page.evaluate(()=>bleFixture.holdFirmware(true));t.release();
      await waitState(page,'updating');await page.waitForFunction(()=>bleFixture.otaBegins===1);
      assert(await page.locator('#settingsDialog').evaluate(node=>node.open));
      assert(await page.locator('#headerCaptureToggle').isDisabled(),'recording locked during actual flash');
      assert(await page.locator('#otaProgress').isVisible());
      await page.locator('#settingsButton').tap();
      assert(await page.locator('#firmwareNoticeProgress').isVisible(),'main page shows the same running transfer');
      assert(await page.locator('#firmwareUpdateButton').isHidden(),'no duplicate update action during transfer');
      await page.evaluate(()=>bleFixture.holdFirmware(false));
      await page.waitForFunction(()=>document.getElementById('firmwareNoticeText').textContent==='Update complete · 1201');await waitState(page,'idle');
      assert.deepEqual(await page.evaluate(()=>[bleFixture.otaBegins,bleFixture.otaCommits,bleFixture.otaOffset,bleFixture.firmwareBuild]),[1,1,8192,1201]);
      assert.equal(await page.evaluate(()=>bleFixture.maximum),1,'no overlapping GATT operations');
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'recording');
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'idle');
      assert.equal(await page.evaluate(async()=>(await new DKAudioStore().all('recordings')).length),2,'recording works after verified reboot');
      assert.deepEqual(t.errors,[]);await t.context.close();
      console.log('PASS full app mobile controls / '+(c3?'C3':'S3')+': connect-record, Settings Stop, busy check, verified OTA, progress, reboot, record again');
    }

    {
      const t=await setup('/?buffered'),{page}=t;await waitReady(page);
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'recording');
      await page.waitForFunction(()=>bleFixture.captured>=8);
      await page.evaluate(()=>{bleFixture.hide();bleFixture.disconnect()});await waitState(page,'disconnected');
      assert.equal(await page.locator('#headerCaptureToggle').getAttribute('aria-label'),'Save received recording');
      await page.locator('#headerCaptureToggle').tap();
      await page.waitForFunction(()=>document.body.dataset.state==='disconnected'&&document.body.dataset.recordingInterrupted==='false');
      assert.equal(await page.evaluate(async()=>(await new DKAudioStore().all('recordings'))[0].status),'saved');
      assert.deepEqual(t.errors,[]);await t.context.close();console.log('PASS interrupted recording can be saved from the visible header');
    }

    {
      const t=await setup('/',()=>{
        const open=IDBFactory.prototype.open;window.qaStorageUnavailable=true;
        IDBFactory.prototype.open=function(...args){if(args[0]==='dk-pendant-recordings'&&qaStorageUnavailable)throw new DOMException('Temporary storage failure','UnknownError');return open.apply(this,args)};
      }),{page}=t;
      await page.waitForFunction(()=>document.body.dataset.startup==='error');
      assert.match(await page.locator('#startupNotice').textContent(),/Temporary storage failure/);
      assert(await page.locator('#headerCaptureToggle').isDisabled());
      await page.locator('#settingsButton').tap();assert(await page.locator('#settingsDialog').evaluate(node=>node.open));
      await page.locator('#closeSettingsButton').tap();
      await page.evaluate(()=>{qaStorageUnavailable=false});
      await page.locator('#startupRetry').tap();await waitReady(page);
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'recording');
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'idle');
      assert.equal(await page.evaluate(()=>bleFixture.starts),1,'retry binds record only once');
      assert.deepEqual(t.errors,[]);await t.context.close();console.log('PASS storage startup failure is visible, Settings works and Retry restores recording');
    }

    {
      const t=await setup('/',()=>Object.defineProperty(navigator,'locks',{configurable:true,value:undefined})),{page}=t;
      await waitReady(page);await page.reload();await waitReady(page);
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'recording');
      await page.locator('#headerCaptureToggle').tap();await waitState(page,'idle');
      assert.deepEqual(t.errors,[]);await t.context.close();console.log('PASS fallback-lock reload initializes and recording works immediately');
    }

    {
      const t=await setup(),other=await t.context.newPage();await waitReady(t.page);await other.goto(origin);
      await other.waitForFunction(()=>document.body.dataset.startup==='error');
      assert.match(await other.locator('#startupNotice').textContent(),/Another pendant tab/);
      await other.locator('#startupRetry').tap();await other.waitForFunction(()=>document.body.dataset.startup==='error');
      assert(await other.locator('#headerCaptureToggle').isDisabled(),'Retry never steals a live page lock');
      await t.page.close();await other.locator('#startupRetry').tap();await waitReady(other);
      await other.locator('#headerCaptureToggle').tap();await waitState(other,'recording');
      await other.locator('#headerCaptureToggle').tap();await waitState(other,'idle');
      await t.context.close();console.log('PASS second tab explains lock conflict and safely recovers after the owner closes');
    }
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
