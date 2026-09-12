/* Populated Actions journeys through the production UI and API adapter. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
  fs.readFile(file,(error,bytes)=>{res.writeHead(error?404:200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(error?'':bytes)});
});
async function seed(page){
  await page.evaluate(async()=>{
    const journal=new DKAudioStore(),createdAt=new Date().toISOString(),yesterday=new Date(Date.now()-86400000).toISOString();
    const names=['Asha','Blair','Casey','Dev','Eli','Fern','Gita','Hari'];
    const actions=Array.from({length:9},(_,i)=>({task:'Review item '+i,owner:'self',due_date:'2026-09-13',start_ms:1000+i*1000}));
    const recording={id:'action-source',name:'Budget planning',createdAt,durationMs:30000,status:'saved',sealed:true,
      blob:DKAudioCodec.wav([new Uint8Array(32000*30)]),transcript:'[00:01] Asha: Discuss the budget.\n[00:07] You: Review the invoice.',summary:'Budget reviewed',
      meeting:{executive_summary:'Budget reviewed',people:names.map(name=>({name})),conversations:[{
        title:'Budget planning',summary:'Budget reviewed',start_ms:7000,end_ms:20000,people:names.map(name=>({name})),
        decisions:[{text:'Approve budget',start_ms:8000}],action_items:actions,follow_ups:[{text:'Send revised quote',owner:'Asha',start_ms:11000}],
        unresolved_questions:[{text:'Who signs?',start_ms:13000}]
      }]}};
    const legacy={id:'older-source',name:'Older meeting',createdAt:yesterday,durationMs:30000,status:'saved',sealed:true,summary:'Older discussion with Iris',
      transcript:'Iris discussed the earlier project',meeting:{people:[{name:'Iris'}],executive_summary:'Older discussion with Iris',action_items:[{task:'Check old estimate',owner:'self',start_ms:3000}]}};
    await journal.atomic(['recordings'],stores=>{stores.recordings.put(recording);stores.recordings.put(legacy)});
    window.qa={signedIn:false,uid:'actions-user',calls:[],held:[],hold:'',fail:'',recording,
      people:names.map((name,i)=>({person_id:'person-'+i,name,role:'colleague',confirmed_by_user:false,conversation_count:1})),
      followups:Array.from({length:34},(_,i)=>({id:'follow-'+i,task:'Cloud follow-up '+i,kind:'commitment',state:'open',owner:{type:i%2?'other':'self',display_name:i%2?'Asha':'You'},source:{recording_id:'action-source',start_ms:7000+i*10}}))};
    SynapAuth.isSignedIn=()=>qa.signedIn;SynapAuth.session=()=>({profile:{uid:qa.uid}});
    SynapAuth.config=()=>({backendUrl:'https://actions-fixture.invalid'});
    SynapAuth.authedFetch=async(url,options={})=>{
      const method=options.method||'GET';qa.calls.push({url,method,body:options.body});
      const kind=url==='/v1/people'?'people':url.startsWith('/v1/follow-ups?')?'followups':url==='/v1/ask'?'ask':url.endsWith('/preparation')?'preparation':method==='PATCH'&&url.startsWith('/v1/follow-ups/')?'done':method==='PATCH'&&url.startsWith('/v1/people/')?'person-save':url.endsWith('/source')?'source':'other';
      const reply=(body,status=200)=>new Response(JSON.stringify(body),{status});
      const data=kind==='people'?{people:structuredClone(qa.people)}:kind==='followups'?{follow_ups:structuredClone(qa.followups)}:null;
      if(qa.hold===kind)await new Promise(resolve=>qa.held.push({kind,resolve,signal:options.signal}));
      if(qa.fail===kind)return reply({error:{message:'Temporary '+kind+' outage'}},503);
      if(data)return reply(data);
      if(kind==='done'){qa.followups=qa.followups.filter(item=>item.id!==url.split('/').pop());return reply({id:url.split('/').pop(),state:'done'})}
      if(method==='PATCH'&&url.startsWith('/v1/people/')){
        const person=qa.people.find(person=>person.person_id===url.split('/').pop()),patch=JSON.parse(options.body);
        if(patch.name)person.name=patch.name;person.confirmed_by_user=true;return reply(person);
      }
      if(kind==='preparation')return reply({history:[{title:'Cloud budget recap',summary:'Budget reviewed',source:{recording_id:'action-source',start_ms:7000},questions:[]}],open_actions:[{text:'Cloud invoice',owner:'self',source:{recording_id:'action-source',start_ms:9000}}],scope:'Recent related conversations and open actions.'});
      if(kind==='ask')return reply({answer:'The budget was reviewed.',confidence:'high',sources:[{recording_id:'action-source',start_ms:7000,quote:'Discuss the budget.'}],searched:{conversations:1}});
      if(kind==='source')return reply({recording_id:'action-source',started_at:createdAt,state:'ready',transcript:recording.transcript,transcript_complete:true,...recording.meeting});
      return reply({recordings:[],merges:[],people:[],follow_ups:[]});
    };
    qa.refreshSession=async()=>{
      SynapAuth.saveConfig({backendUrl:'https://actions-fixture.invalid',clientId:'fixture'});
      localStorage.setItem(SynapAuth.STORAGE_KEY,JSON.stringify({refreshToken:'fixture-refresh',profile:{uid:qa.uid}}));
      const fetch=window.fetch;
      window.fetch=(url,options)=>String(url).endsWith('/v1/auth/refresh')?Promise.resolve(new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600}))):fetch(url,options);
      try{await SynapAuth.refresh()}finally{window.fetch=fetch}
    };
    SynapCloudHistory.refreshUiInPlace({source:'actions-fixture'});
    await SynapBrainUI.refresh();await SynapInteractionSurfaces.refresh();
  });
}
async function run(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.SYNAP_CHROMIUM_PATH?{executablePath:process.env.SYNAP_CHROMIUM_PATH,args:['--no-sandbox']}:{})});
  try{for(const [mode,width]of [['light',320],['dark',390]]){
    const context=await browser.newContext({viewport:{width,height:844},hasTouch:true,reducedMotion:'reduce'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await context.addInitScript(mode=>{localStorage.setItem('synap-appearance',mode);localStorage.setItem('dk-pendant-settings',JSON.stringify({autoProcess:false}))},mode);
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.waitForFunction(()=>document.body.dataset.startup==='ready'&&window.SynapInteractionSurfaces);
    await seed(page);await page.locator('.brain-tabs a[href="#myActions"]').tap();await page.locator('#actionsTab-peopleMemory').tap();
    await page.locator('#peopleBrowseToggle').tap();
    await page.getByRole('button',{name:'Prepare for meeting with Asha',exact:true}).tap();
    const prep=page.locator('.meeting-preparation');await prep.getByText('Who signs? · 0:13').waitFor();
    await page.waitForFunction(()=>document.activeElement?.id==='meetingPreparationTitle');
    assert(await prep.locator('h3').evaluate(node=>{const a=node.getBoundingClientRect(),b=document.getElementById('myActionsContent').getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom}),
      'Prepare must bring its heading into the visible Actions area without another scroll');
    assert.match(await prep.innerText(),/Review item 8/,'local preparation includes mentioned actions with honest status');
    await prep.getByRole('button',{name:'Close',exact:true}).tap();
    await page.locator('#peopleSearch input').fill('Iris');
    await page.getByRole('button',{name:'Prepare for meeting with Iris',exact:true}).tap();
    assert.match(await prep.innerText(),/Older discussion with Iris/,'People and Prepare include older, legacy local memories');
    await prep.getByRole('button',{name:'Close',exact:true}).tap();
    await page.locator('#actionsTab-dailyFocus').tap();
    assert.equal(await page.locator('#commitmentList .source-jump').count(),9,'Next steps does not silently truncate after six items');
    await page.locator('#commitmentList .source-jump').last().tap();
    await page.waitForFunction(()=>document.querySelector('#recording-action-source')?.open);
    await page.waitForFunction(()=>Math.abs(document.querySelector('#recording-action-source audio').currentTime-9)<1);
    await page.locator('.brain-tabs a[href="#myActions"]').tap();
    await page.clock.install();
    await page.evaluate(()=>{qa.signedIn=true;qa.hold='people';qa.fail='followups';qa.refresh=SynapInteractionSurfaces.refresh(true)});
    await page.waitForFunction(()=>qa.held.some(item=>item.kind==='people'));
    await page.locator('#actionsTab-followupInbox').tap();await page.locator('[data-follow="all"]').tap();
    await page.getByRole('button',{name:'Retry Follow-ups',exact:true}).waitFor();
    await page.evaluate(()=>{qa.fail=''});await page.getByRole('button',{name:'Retry Follow-ups',exact:true}).tap();
    await page.waitForFunction(()=>document.querySelectorAll('.synap-follow-done').length===34);
    assert.equal(await page.locator('.synap-follow-done').count(),34,'Follow-ups can retry independently while People is stalled and include all items');
    await page.locator('[data-follow="mine"]').tap();assert.equal(await page.locator('.synap-follow-done').count(),17);
    await page.locator('[data-follow="waiting"]').tap();assert.equal(await page.locator('.synap-follow-done').count(),17);
    await page.locator('[data-follow="all"]').tap();
    await page.clock.runFor(16000);
    await page.locator('#actionsTab-peopleMemory').tap();
    await page.getByRole('button',{name:'Retry People',exact:true}).waitFor();
    await page.evaluate(()=>{qa.hold=''});await page.getByRole('button',{name:'Retry People',exact:true}).tap();
    await page.locator('#peopleSearch input').fill('');
    await page.waitForFunction(()=>document.querySelector('#peopleList [data-person-id="person-0"]'));
    await page.locator('#peopleSearch input').fill('Asha');
    await page.getByRole('button',{name:'Prepare for meeting with Asha',exact:true}).tap();
    await prep.getByText('Cloud invoice · 0:09').waitFor();
    await page.waitForFunction(()=>document.activeElement?.id==='meetingPreparationTitle');
    assert(await prep.locator('h3').evaluate(node=>{const a=node.getBoundingClientRect(),b=document.getElementById('myActionsContent').getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom}));
    await prep.getByRole('button',{name:'Close',exact:true}).tap();
    // A failed rename preserves the user's edit and the native Save submit works.
    const person=page.locator('#peopleList .person-entry').first();
    await person.locator('.person-management summary').tap();
    await person.getByRole('button',{name:'Wrong name',exact:true}).tap();
    const nameInput=person.getByRole('textbox',{name:'Correct this person’s name',exact:true});
    await nameInput.fill('Asha Rao');await page.evaluate(()=>SynapPeopleConfirmUI.decorate());
    assert.equal(await nameInput.inputValue(),'Asha Rao','background decoration preserves an active name editor');
    await page.screenshot({path:'/tmp/synap-person-edit-'+mode+'.png'});
    assert(await nameInput.evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}),'name editor stays inside the mobile viewport');
    await page.evaluate(()=>{qa.fail='person-save'});await person.getByRole('button',{name:'Save',exact:true}).tap();
    await person.getByText('Temporary person-save outage').waitFor();
    assert.equal(await nameInput.inputValue(),'Asha Rao','failed saves retain the entered name');
    assert(await person.getByRole('button',{name:'Save',exact:true}).isEnabled());
    await page.evaluate(()=>{qa.fail=''});await person.getByRole('button',{name:'Save',exact:true}).tap();
    await page.getByRole('button',{name:'Prepare for meeting with Asha Rao',exact:true}).waitFor();
    await page.getByRole('button',{name:'Prepare for meeting with Asha Rao',exact:true}).tap();
    await prep.getByRole('heading',{name:'Before meeting Asha Rao',exact:true}).waitFor();
    await prep.getByRole('button',{name:'Close',exact:true}).tap();
    await page.locator('#actionsTab-followupInbox').tap();
    await page.evaluate(()=>{qa.fail='done'});await page.locator('[data-followup-id="follow-0"]').tap();
    await page.waitForFunction(()=>document.querySelector('#followupError')?.textContent.includes('outage'));
    assert(await page.locator('[data-followup-id="follow-0"]').isEnabled());
    await page.evaluate(()=>{qa.fail='';qa.hold='followups';qa.refresh=SynapInteractionSurfaces.refresh(true)});
    await page.waitForFunction(()=>qa.held.some(item=>item.kind==='followups'));
    await page.locator('[data-followup-id="follow-0"]').tap();
    await page.waitForFunction(()=>!document.querySelector('[data-followup-id="follow-0"]'));
    await page.evaluate(async()=>{qa.hold='';qa.held.filter(item=>item.kind==='followups').forEach(item=>item.resolve());await qa.refresh});
    assert.equal(await page.locator('[data-followup-id="follow-0"]').count(),0,'a stale read cannot restore a completed follow-up');
    await page.locator('#actionsTab-ask').tap();await page.locator('#askInput').fill('What did we decide?');
    await page.evaluate(()=>{qa.hold='ask'});await page.locator('#askForm button[type="submit"]').tap();
    await page.clock.runFor(20001);await page.getByRole('button',{name:'Retry search',exact:true}).waitFor();
    assert(await page.locator('#askInput').isEnabled(),'a stalled Ask request cannot lock the form');
    await page.evaluate(()=>{qa.hold=''});await page.getByRole('button',{name:'Retry search',exact:true}).tap();
    await page.locator('.ask-source').waitFor();assert.match(await page.locator('.ask-answer-text').innerText(),/budget was reviewed/);
    await page.locator('.ask-source').tap();await page.waitForFunction(()=>Math.abs(document.querySelector('#recording-action-source audio').currentTime-7)<1);
    await page.locator('.brain-tabs a[href="#myActions"]').tap();
    await page.locator('#actionsTab-ask').tap();
    await page.evaluate(()=>{qa.hold='ask'});await page.locator('#askInput').fill('Budget');await page.locator('#askForm button[type="submit"]').tap();
    await page.getByRole('button',{name:'Cancel search',exact:true}).tap();
    await page.evaluate(()=>qa.held.filter(item=>item.kind==='ask').forEach(item=>item.resolve()));
    assert.match(await page.locator('#askAnswer').innerText(),/Search cancelled/,'cancelled requests cannot overwrite the next state');
    assert(await page.locator('#askInput').isEnabled());
    await page.evaluate(()=>{qa.hold='';qa.fail='ask'});await page.locator('#askForm button[type="submit"]').tap();
    await page.getByRole('button',{name:'Search this device',exact:true}).tap();
    await page.getByText('Searched saved memories on this device.',{exact:true}).waitFor();
    assert.match(await page.locator('#askAnswer').innerText(),/Budget reviewed/);
    // A cloud-only source must either open or offer a visible retry.
    await page.evaluate(()=>{qa.fail='source';const source=document.querySelector('#askAnswer .source-jump');source.dataset.id='cloud-only-source';source.dataset.offsetMs='7000'});
    await page.locator('#askAnswer .source-jump').first().tap();
    await page.getByRole('button',{name:'Retry source',exact:true}).waitFor();
    assert.match(await page.locator('.synap-source-status').innerText(),/Temporary source outage/);
    await page.evaluate(()=>{qa.fail=''});await page.getByRole('button',{name:'Retry source',exact:true}).tap();
    await page.waitForFunction(()=>document.querySelector('#recording-cloud-only-source')?.open);
    assert.match(await page.locator('#recording-cloud-only-source .recording-transcript').inputValue(),/Discuss the budget/);
    await page.locator('.brain-tabs a[href="#myActions"]').tap();await page.locator('#actionsTab-peopleMemory').tap();
    await page.locator('#peopleSearch input').fill('Asha');await page.evaluate(()=>{qa.hold='preparation'});
    await page.getByRole('button',{name:'Prepare for meeting with Asha Rao',exact:true}).tap();
    await page.waitForFunction(()=>qa.held.some(item=>item.kind==='preparation'));
    await page.evaluate(()=>qa.refreshSession());
    assert(await prep.isVisible(),'a token refresh for the same account must not close preparation');
    assert(await page.evaluate(()=>!qa.held.find(item=>item.kind==='preparation').signal.aborted));
    await page.evaluate(()=>{qa.hold='';qa.held.filter(item=>item.kind==='preparation').forEach(item=>item.resolve())});
    await prep.getByText('Cloud invoice · 0:09').waitFor();await prep.getByRole('button',{name:'Close',exact:true}).tap();
    await page.locator('#peopleSearch input').fill('Blair');
    const blair=page.locator('#peopleList .person-entry').first();await blair.locator('.person-management summary').tap();
    await blair.getByRole('button',{name:'✓ That’s right',exact:true}).tap();await blair.getByText('✓ Confirmed',{exact:true}).waitFor();
    await page.locator('#actionsTab-ask').tap();await page.locator('#askInput').fill('Budget');
    await page.evaluate(()=>{qa.hold='ask'});await page.locator('#askForm button[type="submit"]').tap();
    await page.evaluate(()=>qa.refreshSession());assert(!(await page.locator('#askInput').isEnabled()),'same-account token rotation retains the active search');
    await page.evaluate(async()=>{qa.signedIn=false;await SynapAuth.signOut();qa.held.filter(item=>item.kind==='ask').forEach(item=>item.resolve())});
    assert(await page.locator('#askInput').isEnabled(),'sign-out immediately releases the form');
    assert.equal(await page.locator('#askAnswer .ask-source').count(),0,'a previous account cannot publish its late answer');
    assert.deepEqual(errors,[]);console.log(`PASS functional Actions/${mode}/${width}: visible preparation, older local evidence, all next steps, independent cloud lists, completion retry/race, name correction/confirmation, bounded Ask with sources and token/account changes`);
    await context.close();
  }}finally{await browser.close();server.close()}
}
run().catch(error=>{console.error(error);process.exitCode=1;server.close()});
