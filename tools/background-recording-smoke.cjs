/* Real app + IndexedDB; model lost web callbacks while the native BLE link stays connected. */
'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {createStaticServer,launchChromium}=require('./support/browser-fixture.cjs');
const server=createStaticServer(path.resolve(__dirname,'..'));

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,browser=await launchChromium();
  try {
    for(const mode of ['s3','c3','legacy']) {
      const context=await browser.newContext({viewport:{width:390,height:900}});
      await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
      await context.addInitScript(require('./support/pendant-fixture.cjs'));
      const page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      page.setDefaultTimeout(12000);
      await page.goto(origin+'/?buffered&ota'+(mode==='legacy'?'':'&background')+(mode==='c3'?'&c3':''));
      await page.waitForFunction(()=>document.body.dataset.startup==='ready');
      await page.locator('#headerPendantStatus').click();
      await page.waitForFunction(()=>document.body.dataset.state==='idle'&&bleFixture.armed);
      await page.waitForFunction(()=>SynapModules.client?.module?.id === (location.search.includes('c3') ? 2 : 1));
      assert.equal(await page.locator('#headerPhoto').isVisible(),false,'audio hardware has no camera control');
      assert.equal(await page.locator('#headerVideo').isVisible(),false,'audio hardware has no video control');
      assert.equal(await page.locator('#headerCaptureToggle').isVisible(),true);
      await page.locator('#settingsButton').click();
      assert.match(await page.locator('#moduleExperience').textContent(), /Audio recording, transcripts and memories/);
      assert.match(await page.locator('#moduleExperience').textContent(), mode==='c3' ? /1\.25 seconds/ : /30 seconds/);
      await page.locator('#closeSettingsButton').click();
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(()=>SynapAppControls.recordingState().receivedMs>=500);
      if(mode==='s3') {
        await page.evaluate(()=>bleFixture.hide());
        const before=await page.evaluate(()=>SynapAppControls.recordingState().receivedMs);
        await page.waitForTimeout(1200);
        assert(await page.evaluate(()=>SynapAppControls.recordingState().receivedMs)>before);
        await page.evaluate(()=>bleFixture.show());
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(()=>bleFixture.replayCommands),0);
        assert.equal(await page.evaluate(()=>bleFixture.audioSubscriptions),1);
      }
      await page.evaluate(()=>{bleFixture.blockAudio(true);bleFixture.hide();});
      await page.waitForTimeout(250);
      const before=await page.evaluate(()=>({clock:document.getElementById('timer').textContent,received:SynapAppControls.recordingState().receivedMs}));
      await page.waitForTimeout(2000);
      const absent=await page.evaluate(()=>({clock:document.getElementById('timer').textContent,received:SynapAppControls.recordingState().receivedMs,
        phase:SynapAppControls.recordingState().phase,canMark:SynapAppControls.recordingState().canMark,label:document.querySelector('.header-status-text').textContent}));
      assert.notEqual(absent.clock,before.clock);assert.equal(absent.received,before.received);
      assert.equal(absent.phase,'interrupted');assert.equal(absent.canMark,false);assert.equal(absent.label,'Waiting');
      if(process.env.SYNAP_BACKGROUND_SCREENSHOT&&mode==='s3')await page.screenshot({path:process.env.SYNAP_BACKGROUND_SCREENSHOT,fullPage:true});
      await page.evaluate(()=>{bleFixture.blockAudio(false);bleFixture.show();});
      if(mode!=='legacy')await page.waitForFunction(()=>bleFixture.replayCommands===1&&bleFixture.pendingFrames===0);
      else await page.waitForFunction(()=>document.body.dataset.audioDelivery==='receiving');
      await page.locator('#headerCaptureToggle').click();
      await page.waitForFunction(()=>document.body.dataset.state==='idle');
      const result=await page.evaluate(async()=>{
        const store=new DKAudioStore(),records=await store.all('recordings'),saved=records[0];
        const blob=await store.blob(saved),wav=new DataView(await blob.arrayBuffer());
        let zeroFrames=0,badSamples=0;
        for(let sequence=0;sequence<(wav.byteLength-44)/1600;sequence++) {
          const at=44+sequence*1600,missing=wav.getInt16(at,true)===0;
          if(missing)zeroFrames++;
          for(let sample=0;sample<800;sample++)if(wav.getInt16(at+sample*2,true)!==(missing?0:(sequence%20000)+1))badSamples++;
        }
        return {recordings:records.length,stats:saved.stats,duration:saved.durationMs,zeroFrames,badSamples,
          captured:bleFixture.captured,starts:bleFixture.starts,replays:bleFixture.replayCommands,disconnects:bleFixture.appDisconnects};
      });
      assert.equal(result.recordings,1);assert.equal(result.starts,1);assert.equal(result.disconnects,0);
      assert.equal(result.badSamples,0,'received PCM and replayed PCM must remain exact');
      assert.equal(result.duration,result.captured*50);
      assert.equal(result.stats.completeFrames+result.stats.missingFrames,result.captured);
      assert.equal(result.zeroFrames,result.stats.missingFrames);
      if(mode==='s3'){assert.equal(result.zeroFrames,0);assert.equal(result.stats.completeFrames,result.captured);}
      else assert(result.zeroFrames>0,'unrecoverable samples are visible gaps, never invented sound');
      assert.equal(result.replays,mode==='legacy'?0:1);assert.deepEqual(errors,[]);
      console.log('PASS background/'+mode+': one recording, exact PCM, '+result.stats.missingFrames+' explicit missing frames');
      await context.close();
    }
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
