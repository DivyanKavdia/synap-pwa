/* Verify Settings against the real shell; BLE behavior is in connection-smoke. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=process.env.SYNAP_SETTINGS_OUTPUT||'/tmp/synap-settings-qa';
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data)})});
async function hit(page,selector){
  assert(await page.locator(selector).evaluate(node=>{
    const r=node.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return node===top||node.contains(top);
  }),selector+' must remain unobscured');
}
async function run(){
  fs.mkdirSync(out,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.SYNAP_CHROMIUM_PATH?{executablePath:process.env.SYNAP_CHROMIUM_PATH,args:['--no-sandbox']}:{})});
  try{
    for(const mode of ['light','dark'])for(const width of [320,390,1440]){
      const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
      await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
      await context.addInitScript(mode=>localStorage.setItem('synap-appearance',mode),mode);
      const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin);await page.waitForFunction(()=>window.SynapSettingsPanel&&document.querySelector('#headerCaptureToggle'));
      assert.equal(await page.locator('#openAsk,#synapSearchMemories,#setupConnect,.settings-brand-logo').count(),0);
      assert.equal(await page.locator('.brain-tabs a[href="#myActions"]').count(),1);
      assert.equal(await page.locator('#askForm,#librarySearch').count(),2);
      await page.locator('.brain-tabs a[href="#library"]').click();
      const before=await page.evaluate(()=>{window.originalHeader=document.querySelector('.topbar');return {scroll:scrollY,header:originalHeader.getBoundingClientRect().toJSON()}});
      const settingsBounds=await page.locator('#settingsButton').boundingBox();
      await page.mouse.click(settingsBounds.x+settingsBounds.width/2,settingsBounds.y+settingsBounds.height/2);
      await page.waitForFunction(()=>document.body.classList.contains('settings-open'));
      assert(await page.locator('main').evaluate(node=>node.inert));
      assert(await page.evaluate(()=>originalHeader===document.querySelector('.topbar')),'same header node and handlers');
      assert(await page.locator('#settingsDialog').evaluate(node=>!node.matches(':modal')),'settings does not make the header inert');
      const after=await page.locator('.topbar').boundingBox();
      for(const key of ['x','y','width','height'])assert(Math.abs(after[key]-before.header[key])<1,'header position: '+key);
      for(const selector of ['#headerPendantStatus','#headerCaptureToggle','#headerBatteryStatus','#settingsButton','.brain-tabs a[href="#myActions"]'])await hit(page,selector);
      await page.locator('#headerBatteryStatus').click();
      assert(await page.locator('#synapBatteryPopover').isVisible(),'battery details still open above settings');
      await page.locator('#headerBatteryStatus').click();
      const controls=['setupDeviceId','chooseDeviceButton','otaReleaseCheck','wakeLockInput','autoReconnectInput','providerInput','autoProcessInput','synapSignInButton','diagnostics','settingsSaveButton'];
      for(const id of controls)assert.equal(await page.locator('[id="'+id+'"]').count(),1,'one owner for '+id);
      assert.equal(await page.locator('#connectButton:visible').count(),0,'header owns the single visible connection control');
      const tabs=page.locator('.settings-tabs [role="tab"]');
      assert.deepEqual(await tabs.allTextContents(),['Device','Memory','Appearance','Support']);
      await page.screenshot({path:path.join(out,`settings-device-${mode}-${width}.png`)});
      await page.locator('#wakeLockInput').uncheck();
      await page.evaluate(()=>{window.settingsOriginalInput=document.getElementById('wakeLockInput')});
      for(const section of ['memory','appearance','support','device']){
        await page.locator('#settingsTab-'+section).click();
        assert.equal(await page.locator('[data-settings-panel]:visible').count(),1);
        assert.equal(await page.locator('.settings-tabs [aria-selected="true"]').count(),1);
        assert(await tabs.evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth)),'tab labels fit without clipping or overlapping');
        assert.equal(await page.locator('#settingsSaveButton:visible').count(),1);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        if(section==='memory'){
          await page.locator('#settingsProcessingOptions > summary').click();
          await page.locator('#providerInput').selectOption('custom');assert(await page.locator('#endpointInput').isVisible());
          await page.locator('#providerInput').selectOption('synap');assert(await page.locator('#synapSignInButton').isVisible());
          await page.locator('#settingsProcessingOptions > summary').click();
        }
        if(section==='appearance'){
          await page.locator('[data-theme-choice="'+mode+'"]').click();
          await page.locator('[data-palette-choice="lavender"]').click();
          assert.equal(await page.evaluate(()=>localStorage.getItem('synap-palette')),'lavender');
          await page.locator('[data-palette-choice="olive"]').click();
        }
        if(section==='support'){
          assert.equal(await page.locator('#settingsConnectionHealth #pendantHealth').count(),1);
          await page.locator('#diagnostics > summary').click();
          assert(await page.locator('#copyDiagnosticsButton').isVisible());
          await page.locator('#diagnostics > summary').click();
        }
        await page.screenshot({path:path.join(out,`settings-${section}-${mode}-${width}.png`)});
      }
      assert(await page.evaluate(()=>settingsOriginalInput===document.getElementById('wakeLockInput')&&!settingsOriginalInput.checked),'panels preserve live inputs and drafts');
      await page.locator('#settingsTab-device').focus();await page.keyboard.press('End');
      assert.equal(await page.locator('#settingsTab-support').getAttribute('aria-selected'),'true');
      await page.keyboard.press('Home');
      assert.equal(await page.locator('#settingsTab-device').getAttribute('aria-selected'),'true');
      await page.locator('#settingsDialog').evaluate(node=>node.scrollTop=400);
      await hit(page,'#headerCaptureToggle');await hit(page,'#closeSettingsButton');
      await page.screenshot({path:path.join(out,`settings-${mode}-${width}.png`)});
      await page.locator('#settingsButton').click();await page.waitForTimeout(100);
      assert(!(await page.locator('#settingsDialog').evaluate(node=>node.open)),'single tap closes without fallback reopening');
      assert(!(await page.locator('main').evaluate(node=>node.inert)));
      const returnedScroll=await page.evaluate(()=>scrollY);
      assert(Math.abs(returnedScroll-before.scroll)<1,`return to original reading position: ${before.scroll} → ${returnedScroll}`);
      await page.locator('#settingsButton').click();await page.locator('#wakeLockInput').uncheck();
      await page.locator('#settingsSaveButton').click();
      await page.waitForFunction(()=>!document.querySelector('#settingsDialog').open);
      assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dk-pendant-settings')).wakeLock),false);
      await page.locator('#settingsButton').click();await page.keyboard.press('Escape');
      assert(!(await page.locator('#settingsDialog').evaluate(node=>node.open)));
      assert.equal(await page.evaluate(()=>document.activeElement.id),'settingsButton');
      await page.locator('#settingsButton').click();await page.locator('.brain-tabs a[href="#myActions"]').click();
      assert(!(await page.locator('#settingsDialog').evaluate(node=>node.open)));
      assert(await page.locator('#askInput').isVisible());
      assert(!(await page.locator('main').evaluate(node=>node.inert)));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false,'no horizontal overflow');
      assert.deepEqual(errors,[]);console.log(`PASS settings/${mode}/${width}: fixed header, battery, independent scroll, navigation, save, Escape and deduplication`);
      await context.close();
    }
  }finally{await browser.close();server.close()}
}
run().catch(error=>{console.error(error);server.close();process.exitCode=1});
