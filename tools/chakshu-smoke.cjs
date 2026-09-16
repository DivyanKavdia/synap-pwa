'use strict';
const {createStaticServer,launchChromium}=require('./support/browser-fixture.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const server=createStaticServer(path.resolve(__dirname,'..'));
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,browser=await launchChromium();
  try {
    for(const width of [390,1280]) {
      const context=await browser.newContext({viewport:{width,height:900}});
      await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      const page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
      await page.goto(origin+'/?chakshu');
      await page.waitForFunction(()=>document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'));
      await page.locator('#headerPendantStatus').click();
      await page.waitForFunction(()=>document.body.dataset.state==='idle'&&SynapModules.client?.module?.id===3);
      await page.locator('#settingsButton').click();
      await page.locator('#moduleSettings').waitFor({state:'visible'});
      assert.match(await page.locator('#moduleName').textContent(),/Chakshu/);
      assert.match(await page.locator('#chakshuCamera').textContent(),/OV3660/);
      assert.match(await page.locator('#chakshuStorage').textContent(),/1,800 MiB free/);
      await page.locator('[data-chakshu-operation="3"]').click();
      await page.waitForFunction(()=>bleFixture.mediaWrites===1&&SynapModules.busy);
      assert.equal(await page.locator('[data-chakshu-operation="3"]').isDisabled(),true);
      assert.equal(await page.locator('[data-chakshu-operation="2"]').count(),0);
      assert.equal(await page.locator('[data-chakshu-operation="4"]').count(),0);
      await page.evaluate(()=>SynapAppControls.toggleCapture());
      assert.equal(await page.evaluate(()=>bleFixture.starts),0,'SD check blocks competing live recording');
      await page.evaluate(async()=>{bleFixture.finishMedia();await SynapModules.refresh();});
      await page.waitForFunction(()=>!SynapModules.busy);
      assert.match(await page.locator('#chakshuFile').textContent(),/\.wav$/);
      await page.evaluate(async()=>{bleFixture.setSdAvailable(false);await SynapModules.refresh();});
      assert.equal(await page.locator('[data-chakshu-operation="3"]').isDisabled(),true);
      assert.match(await page.locator('#chakshuStorage').textContent(),/unavailable/);
      assert.equal(await page.locator('[data-chakshu-operation="1"]').isDisabled(),false);
      await page.evaluate(async()=>{bleFixture.setSdAvailable(true);await SynapModules.refresh();});
      fs.mkdirSync('artifacts/workflows/chakshu',{recursive:true});
      await page.screenshot({path:'artifacts/workflows/chakshu/device-'+width+'.png',fullPage:true});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('#closeSettingsButton').click();
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(()=>bleFixture.captured>=4);
      await assert.rejects(page.evaluate(()=>SynapModules.run(2)),/Finish/);
      const rec=await page.evaluate(()=>SynapAppControls.recordingState());
      await page.evaluate(s=>SynapAppControls.stopCapture(s.sessionId),rec);
      await page.waitForFunction(()=>!SynapAppControls.recordingState().active);
      assert.equal(await page.evaluate(()=>bleFixture.maximum),1,'optional media discovery uses the shared GATT queue');
      assert.deepEqual(errors,[]);
      await context.close();
    }
    console.log('PASS Chakshu detection, SD checks, media exclusion, missing card, mobile and desktop layout');
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
