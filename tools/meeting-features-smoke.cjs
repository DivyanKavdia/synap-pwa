'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data)})});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.SYNAP_CHROMIUM_PATH?{executablePath:process.env.SYNAP_CHROMIUM_PATH,args:['--no-sandbox']}:{})});
  try{for(const mode of ['light','dark']){
    const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:mode});
    await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
    await context.addInitScript(mode=>{localStorage.setItem('synap-appearance',mode);localStorage.setItem('dk-pendant-settings',JSON.stringify({autoProcess:false,wakeLock:false}));},mode);
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.waitForFunction(()=>document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'));
    await page.evaluate(async()=>{
      const store=new DKAudioStore();await store.open();
      const pcm=new Uint8Array(32000*30),blob=DKAudioCodec.wav([pcm]);
      const record={id:'qa-meeting',name:'Budget planning',createdAt:new Date().toISOString(),durationMs:30000,sampleRate:16000,sizeBytes:blob.size,blob,status:'saved',processingStage:'ready',summary:'Budget reviewed. Invoice pending.',transcript:'[00:01] Asha: We agreed the budget. [00:12] YOU: remind me tomorrow to send the invoice.',audioQuality:{samples:480000,rms:.001,clippedRatio:0,lowRatio:0},meeting:{people:[{name:'Asha',role:'colleague',evidence:'speaker'}],topics:['Budget'],conversations:[{title:'Budget planning',summary:'Budget reviewed.',start_ms:0,end_ms:30000,people:[{name:'Asha'}],participants:['Asha'],topics:['Budget'],chapters:[{title:'Budget',summary:'Costs approved.',start_ms:0,end_ms:10000},{title:'Invoice',summary:'Send tomorrow.',start_ms:10000,end_ms:30000}],decisions:[{text:'Budget approved',start_ms:1000,end_ms:3000}],action_items:[{task:'Send invoice',kind:'reminder',owner:'self',due_date:'2026-09-13',start_ms:12000,end_ms:14000}],unresolved_questions:[{text:'Who signs?',start_ms:20000,end_ms:23000}],follow_ups:[]}]}};await store.atomic(['recordings'],stores=>stores.recordings.put(record));
    });
    await page.reload();await page.waitForFunction(()=>document.querySelector('#diagnosticsLog')?.textContent.includes('Application started'));
    await page.locator('.brain-tabs a[href="#library"]').click();await page.locator('#recording-qa-meeting > summary').click();
    const details=page.locator('#recording-qa-meeting .meeting-detail');await details.locator('summary').click();
    assert((await details.innerText()).includes('Suggested reminder'));assert((await details.innerText()).includes('Who signs?'));assert((await details.innerText()).includes('Very quiet'));
    await details.screenshot({path:'/tmp/synap-meeting-detail-'+mode+'.png'});
    await details.getByRole('button',{name:'Invoice · 0:10',exact:true}).click();
    await page.waitForFunction(()=>Math.abs(document.querySelector('#recording-qa-meeting audio').currentTime-10)<1);
    await page.locator('.brain-tabs a[href="#myActions"]').click();await page.locator('#actionsTab-peopleMemory').click();
    await page.getByRole('button',{name:'Prepare for meeting with Asha'}).click();
    const prep=page.locator('#peopleMemory .meeting-preparation');await prep.getByText('Budget planning · 0:00').waitFor();assert((await prep.innerText()).includes('Who signs?'));
    assert.equal(await page.locator('#peopleMemory .meeting-preparation').count(),1);assert.equal(await page.locator('.actions-tabs [role="tab"]').count(),4);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:'/tmp/synap-meetings-'+mode+'.png'});
    await prep.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await page.locator('.meeting-preparation').count(),0);
    await page.clock.install();
    await page.evaluate(()=>{
      window.qaPreparationRequests=[];window.qaOriginalIsSignedIn=SynapAuth.isSignedIn;
      SynapAuth.isSignedIn=()=>true;
      const fetch=SynapAuth.authedFetch;
      SynapAuth.authedFetch=(url,options)=>url.endsWith('/preparation')
        ? new Promise(resolve=>qaPreparationRequests.push({url,signal:options.signal,resolve}))
        : fetch(url,options);
      const list=document.getElementById('peopleList');list.replaceChildren();
      for(const name of ['Asha','Blair']){const card=document.createElement('button');card.type='button';card.className='person-card';card.dataset.person=name;card.textContent=name;list.append(card)}
      SynapMeetingTools.decoratePeople([{id:'asha',name:'Asha'},{id:'blair',name:'Blair'}],[]);
    });
    const requests=()=>page.evaluate(()=>qaPreparationRequests.length);
    const answer=(index,title)=>page.evaluate(({index,title})=>qaPreparationRequests[index].resolve({ok:true,json:async()=>({history:[{title,summary:'Cloud recap',source:{recording_id:'qa-meeting',start_ms:1000},questions:[]}],open_actions:[],scope:'Recent cloud conversations.'})}),{index,title});
    await page.getByRole('button',{name:'Prepare for meeting with Asha'}).click();assert.equal(await requests(),1);
    assert.equal(await prep.locator('[aria-busy="true"]').count(),1);
    await prep.getByRole('button',{name:'Close',exact:true}).click();assert(await page.evaluate(()=>qaPreparationRequests[0].signal.aborted));
    await answer(0,'Late Asha');await page.waitForTimeout(20);assert.equal(await page.locator('.meeting-preparation').count(),0);

    await page.getByRole('button',{name:'Prepare for meeting with Asha'}).click();
    await page.getByRole('button',{name:'Prepare for meeting with Blair'}).click();assert.equal(await requests(),3);
    assert(await page.evaluate(()=>qaPreparationRequests[1].signal.aborted));
    await answer(2,'Blair discussion');await prep.getByText('Blair discussion · 0:01').waitFor();
    await answer(1,'Late Asha');await page.waitForTimeout(20);assert(!(await prep.innerText()).includes('Late Asha'));

    await page.getByRole('button',{name:'Prepare for meeting with Asha'}).click();assert.equal(await requests(),4);
    await page.clock.fastForward(15001);await prep.getByText('Meeting preparation timed out. Try again.').waitFor();
    assert(await page.evaluate(()=>qaPreparationRequests[3].signal.aborted));assert.equal(await prep.locator('[aria-busy="false"]').count(),1);
    await prep.getByRole('button',{name:'Retry',exact:true}).click();assert.equal(await requests(),5);
    await answer(4,'Retried discussion');await prep.getByText('Retried discussion · 0:01').waitFor();
    await page.screenshot({path:'/tmp/synap-preparation-retry-'+mode+'.png'});

    await page.getByRole('button',{name:'Prepare for meeting with Asha'}).click();assert.equal(await requests(),6);
    await page.evaluate(()=>{SynapAuth.isSignedIn=qaOriginalIsSignedIn;return SynapAuth.signOut()});
    assert(await page.evaluate(()=>qaPreparationRequests[5].signal.aborted));
    await answer(5,'Prior account');await page.waitForTimeout(20);assert.equal(await page.locator('.meeting-preparation').count(),0);
    console.log('PASS preparation/'+mode+': Close during loading, person changes, request timeout, retry and sign-out discard late responses');
    assert.deepEqual(errors,[]);console.log('PASS meeting features/'+mode+': chapter playback, suggested reminders, quality, inline preparation and compact tabs');
    await context.close();
  }}finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
