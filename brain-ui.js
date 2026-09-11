/* Synap second-brain UX: highlights, people memory, follow-up inbox and grounded recall. */
(function(root){
  'use strict';
  if(root.SynapBrainUI&&root.SynapBrainUI.__singleton)return;
  const DB='dk-pendant-recordings';
  const HKEY='synap-memory-highlights';
  let records=[],initialized=false,refreshVersion=0,readError=false,renderedDay='',conversationLimit=3,briefExpanded=false;

  const $=s=>document.querySelector(s);
  const $$=s=>[...document.querySelectorAll(s)];
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const day=v=>{const d=new Date(v);return[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
  const today=()=>day(Date.now());
  const mine=o=>/^(me|i|myself|self|you|user)$/i.test(String(o||'').trim());
  const fmt=v=>new Date(v).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  function sourceOffset(value,conversation){if(value?.start_ms!=null&&Number.isFinite(Number(value.start_ms)))return Number(value.start_ms);if(value?.start_seconds!=null&&Number.isFinite(Number(value.start_seconds)))return Number(value.start_seconds)*1000;if(conversation?.start_ms!=null&&Number.isFinite(Number(conversation.start_ms)))return Number(conversation.start_ms);if(conversation?.start_seconds!=null&&Number.isFinite(Number(conversation.start_seconds)))return Number(conversation.start_seconds)*1000;return 0}

  function highlights(){try{return JSON.parse(localStorage.getItem(HKEY)||'[]')}catch(_){return[]}}
  function openDb(){return new Promise((res,rej)=>{const r=indexedDB.open(DB);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
  async function load(){const db=await openDb();try{return await new Promise((res,rej)=>{const r=db.transaction('recordings').objectStore('recordings').getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}finally{db.close()}}

  function selected(){return $('#datePicker')?.value||today()}
  function meeting(r){return r?.meeting||{}}
  function conversationsOf(r){const m=meeting(r),list=Array.isArray(m.conversations)&&m.conversations.length?m.conversations:r?.conversations;return Array.isArray(list)?list:[]}
  function textOf(value){if(value==null)return'';if(typeof value==='string')return value.trim();if(typeof value.text==='string')return value.text.trim();return''}
  function dedupe(items,keyFn){const seen=new Set(),out=[];for(const item of items||[]){const key=keyFn(item);if(!key||seen.has(key))continue;seen.add(key);out.push(item)}return out}
  function decisionEntries(r){const m=meeting(r),all=[];for(const x of m.decisions||[])all.push({value:x,conversation:null});for(const c of conversationsOf(r))for(const x of c.decisions||[])all.push({value:x,conversation:c});return dedupe(all,x=>{const t=textOf(x.value).toLowerCase(),start=sourceOffset(x.value,x.conversation);return t?t+'|'+start:''})}
  function actionEntries(r){const m=meeting(r),all=[];for(const x of m.action_items||[])all.push({value:x,conversation:null});for(const c of conversationsOf(r))for(const x of c.action_items||[])all.push({value:x,conversation:c});return dedupe(all,x=>{const a=x.value||{},task=String(a.task||'').trim().toLowerCase(),start=sourceOffset(a,x.conversation);return task?task+'|'+String(a.owner||'').trim().toLowerCase()+'|'+start:''})}
  function followUpEntries(r){const m=meeting(r),all=[];for(const x of m.follow_ups||[])all.push({value:x,conversation:null});for(const c of conversationsOf(r))for(const x of c.follow_ups||[])all.push({value:x,conversation:c});return dedupe(all,x=>{const t=textOf(x.value).toLowerCase(),owner=String(x.value?.owner||'').trim().toLowerCase(),start=sourceOffset(x.value,x.conversation);return t?t+'|'+owner+'|'+start:''})}
  function topicsOf(r){const m=meeting(r),all=[...(m.topics||[])];for(const c of conversationsOf(r))all.push(...(c.topics||[]));return[...new Set(all.map(x=>String(x||'').trim()).filter(Boolean))]}

  function summaryOf(r){return String(meeting(r).executive_summary||r.summary||conversationsOf(r).map(c=>c.summary).filter(Boolean).join('\n\n')).trim()}
  function participantNames(c){return dedupe((Array.isArray(c.participants)?c.participants:[]).filter(x=>typeof x==='string'&&x.trim()).map(x=>mine(x)?'You':x.trim()),x=>x.toLowerCase())}
  function conversationModel(r,c){
    const startMs=Math.max(0,sourceOffset(c)),stamp=new Date(new Date(r.createdAt).getTime()+startMs);
    return {key:String(r.id)+'|'+startMs+'|'+String(c.title||''),id:r.id,startMs,title:c.title||r.name||'Conversation',
      time:Number.isFinite(stamp.getTime())?fmt(stamp):'',summary:String(c.summary||''),participants:participantNames(c),
      decisions:(c.decisions||[]).map(textOf).filter(Boolean),
      actions:(c.action_items||[]).filter(a=>a?.task).map(a=>({text:String(a.task),meta:[mine(a.owner)?'You':a.owner,a.due_date].filter(Boolean).join(' · ')})),
      followUps:(c.follow_ups||[]).map(x=>({text:textOf(x),meta:mine(x?.owner)?'You':x?.owner||''})).filter(x=>x.text),
      points:(c.key_points||[]).map(textOf).filter(Boolean),topics:(c.topics||[]).map(String).filter(Boolean)};
  }

  function renderBrief(list,d){
    const summaries=list.filter(r=>summaryOf(r)),pending=list.length-summaries.length;
    const text=$('#dayBriefText');if(text){text.textContent=summaries.length?summaries.map(summaryOf).join('\n\n'):list.length?'Your recordings are saved. Summaries will appear here as processing finishes.':'No recordings for this day yet.';text.classList.toggle('is-expanded',briefExpanded)}
    const date=$('#brainDateLine');if(date)date.textContent=new Date(selected()+'T12:00:00').toLocaleDateString([],{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    const toggle=$('#dayBriefReadMore');if(toggle){toggle.hidden=!summaries.length;toggle.textContent=briefExpanded?'Show less':'Read full day';toggle.setAttribute('aria-expanded',String(briefExpanded))}
    const sources=$('#dayBriefSources');if(sources){sources.hidden=!briefExpanded||!summaries.length;sources.innerHTML=summaries.map(r=>`<button type="button" class="source-jump" data-id="${esc(r.id)}" data-offset-ms="0">${esc(r.name||'Recording')} · ${esc(fmt(r.createdAt))}</button>`).join('')}
    const status=$('#dayBriefStatus');if(status){status.hidden=!readError&&!pending;status.textContent=readError?'Saved memories could not refresh. Showing the last available summaries.':`${pending} recording${pending===1?'':'s'} awaiting a summary.`}
    const pulseLabel=$('.pulse-label');if(pulseLabel)pulseLabel.textContent=selected()===today()?'TODAY AT A GLANCE':'THIS DAY AT A GLANCE';
  }

  function digestMarkup(item){
    const section=(label,items)=>items.length?`<section class="digest-facts"><h4>${label}</h4><ul>${items.map(x=>`<li>${esc(typeof x==='string'?x:x.text)}${x.meta?`<small>${esc(x.meta)}</small>`:''}</li>`).join('')}</ul></section>`:'';
    return `<summary class="conversation-card"><span class="conversation-time">${esc(item.time)}</span><span class="conversation-copy"><strong>${esc(item.title)}</strong>${item.participants.length?`<span class="conversation-people">With ${esc(item.participants.join(' · '))}</span>`:''}</span><svg class="conversation-arrow" aria-hidden="true"><use href="#i-chevron"/></svg></summary><div class="conversation-detail"><p class="digest-summary">${esc(item.summary||'Summary is not available for this conversation yet.')}</p>${section('Key points',item.points)}${section('Decisions',item.decisions)}${section('Next steps',item.actions)}${section('Follow-ups',item.followUps)}${item.topics.length?`<p class="digest-topics">${item.topics.map(esc).join(' · ')}</p>`:''}<button type="button" class="conversation-source source-jump" data-id="${esc(item.id)}" data-offset-ms="${item.startMs}">Open recording & source ↗</button></div>`;
  }

  function renderConversations(items){
    const container=$('#conversationList');if(!container)return;
    const previous=new Map([...container.querySelectorAll('.conversation-digest')].map(n=>[n.dataset.key,n])),keys=new Set();
    if(items.length)container.querySelector('.brain-empty')?.remove();
    items.slice(0,conversationLimit).forEach(({r,c},index)=>{
      const item=conversationModel(r,c),key=item.key;keys.add(key);
      let node=previous.get(key);if(!node){node=document.createElement('details');node.className='conversation-digest';node.dataset.key=key;node.open=false}
      const markup=digestMarkup(item);if(node.__markup!==markup){node.innerHTML=markup;node.__markup=markup}
      if(container.children[index]!==node)container.insertBefore(node,container.children[index]||null);
    });
    for(const[key,node]of previous)if(!keys.has(key))node.remove();
    if(!items.length)container.innerHTML='<p class="brain-empty">Conversation summaries will appear here after processing.</p>';
    const count=$('#conversationPageCount');if(count)count.textContent=items.length?`${Math.min(conversationLimit,items.length)} of ${items.length} summaries`:'';
    const more=$('#showMoreConversations');if(more)more.hidden=items.length<=conversationLimit;
  }

  function rows(items,kind){if(!items.length)return'<p class="brain-empty">Nothing detected yet.</p>';return items.slice(0,6).map(x=>`<button type="button" class="brain-action-row source-jump" data-id="${esc(x.r.id)}" data-offset-ms="${Math.max(0,Number(x.startMs)||0)}"><span class="brain-action-icon">${kind==='decision'?'✓':kind==='mine'?'→':'←'}</span><span><strong>${esc(x.text)}</strong>${x.meta?`<small>${esc(x.meta)}</small>`:''}</span></button>`).join('')}

  function derive(list){
    const decisions=[],my=[],waiting=[],topics=new Map(),people=new Map(),conversations=[];
    for(const r of list||[]){
      const m=meeting(r);
      for(const entry of decisionEntries(r)){const text=textOf(entry.value);if(!text)continue;decisions.push({r,text,startMs:sourceOffset(entry.value,entry.conversation),meta:entry.conversation?.title||r.name||fmt(r.createdAt)})}
      for(const entry of actionEntries(r)){const a=entry.value||{},task=String(a.task||'').trim();if(!task)continue;const owner=String(a.owner||'').trim(),due=a.due_date||'',item={r,text:task,owner,due,startMs:sourceOffset(a,entry.conversation),meta:[owner,due].filter(Boolean).join(' · ')};(mine(owner)||!owner?my:waiting).push(item)}
      for(const entry of followUpEntries(r)){const text=textOf(entry.value);if(!text)continue;const owner=String(entry.value?.owner||'').trim(),item={r,text,owner,due:'',startMs:sourceOffset(entry.value,entry.conversation),meta:[owner,'Follow-up'].filter(Boolean).join(' · ')};(mine(owner)?my:waiting).push(item)}
      for(const t of topicsOf(r))topics.set(t,(topics.get(t)||0)+1);
      for(const p of m.people||r.people||[]){if(!p?.name||mine(p.name))continue;const k=p.name.trim().toLowerCase(),old=people.get(k)||{name:p.name,count:0,role:p.role||'',evidence:[],records:new Map(),topics:new Map(),last:0};old.count++;if(p.role&&!old.role)old.role=p.role;if(p.evidence&&!old.evidence.includes(p.evidence))old.evidence.push(p.evidence);old.records.set(r.id,r);old.last=Math.max(old.last,new Date(r.createdAt).getTime());for(const t of topicsOf(r))old.topics.set(t,(old.topics.get(t)||0)+1);people.set(k,old)}
      for(const c of conversationsOf(r))conversations.push({r,c,startMs:sourceOffset(c)})
    }
    return{decisions,my,waiting,topics:[...topics].sort((a,b)=>b[1]-a[1]),people:[...people.values()].sort((a,b)=>b.last-a.last),conversations:conversations.sort((a,b)=>new Date(b.r.createdAt)-new Date(a.r.createdAt)||a.startMs-b.startMs)};
  }

  function ensureSections(){
    const brief=$('.day-brief'),glance=brief?.querySelector('.glance-grid');
    if(brief&&glance&&!$('#actionableMemory')){const n=document.createElement('div');n.id='actionableMemory';n.className='actionable-memory';n.innerHTML='<div class="memory-pulse"><div><span class="pulse-label">TODAY AT A GLANCE</span><strong id="pulseLine">synap is building your day.</strong></div><div class="pulse-actions"><button id="rememberThis" class="remember-pill" type="button">★ Remember this</button></div></div><div class="action-grid"><section><header><span>Decisions</span><b id="decisionCount">0</b></header><div id="decisionList"></div></section><section><header><span>My commitments</span><b id="commitmentCount">0</b></header><div id="commitmentList"></div></section><section><header><span>Waiting on</span><b id="waitingCount">0</b></header><div id="waitingList"></div></section></div><div id="contextChips" class="context-chips"></div><section class="conversation-lane"><header><span>Conversations</span><b id="conversationCount">0</b></header><div id="conversationList" class="conversation-list"></div></section>';brief.insertBefore(n,glance);glance.classList.add('secondary-metrics')}
    const insights=$('#insights');
    if(insights&&!$('#followupInbox')){const inbox=document.createElement('section');inbox.id='followupInbox';inbox.className='section-card followup-inbox';inbox.innerHTML='<div class="section-heading"><div><p class="section-eyebrow">FOLLOW THROUGH</p><h2>Follow-up inbox <span id="followupCount" class="count-badge">0</span></h2><p class="section-copy">What you owe, what others owe you, and what still needs closure.</p></div></div><div class="followup-tabs"><button data-follow="mine" class="active">You owe</button><button data-follow="waiting">Waiting on</button><button data-follow="all">All</button></div><div id="followupList"></div>';insights.after(inbox)}
    const inbox=$('#followupInbox');
    if(inbox&&!$('#peopleMemory')){const people=document.createElement('section');people.id='peopleMemory';people.className='section-card people-memory';people.innerHTML='<div class="section-heading"><div><p class="section-eyebrow">PEOPLE MEMORY</p><h2>People</h2><p class="section-copy">Who you spoke with, what you discussed, and what remains open.</p></div></div><div id="peopleList" class="people-grid"></div>';inbox.after(people)}
    const library=$('#library');
    if(library&&!$('#ask')){const ask=document.createElement('section');ask.id='ask';ask.className='section-card ask-synap';ask.innerHTML='<div class="ask-head"><span class="ask-orb">✦</span><div><p class="section-eyebrow">RECALL</p><h2>Ask synap</h2><p class="section-copy">Ask about people, conversations, decisions or commitments. Every answer links to its source.</p></div></div><form id="askForm" class="ask-form"><input id="askInput" type="search" autocomplete="off" aria-label="Ask a question about your memories" placeholder="What would you like to remember?"><button type="submit">Ask</button></form><div class="ask-suggestions"><button type="button">What did I decide today?</button><button type="button">Who did I speak with today?</button><button type="button">What am I waiting on?</button></div><div id="askAnswer" class="ask-answer" aria-live="polite"><p class="brain-empty">Your answers will cite the conversations they came from.</p></div>';library.before(ask)}
    const nav=$('.brain-tabs');if(nav&&!nav.querySelector('a[href="#myActions"]')){const a=document.createElement('a');a.href='#myActions';a.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m3 6 2 2 4-4M12 6h9M3 12l2 2 4-4M12 12h9M3 18l2 2 4-4M12 18h9"/></svg><span>Actions</span>';nav.insertBefore(a,nav.querySelector('a[href="#library"]'))}
  }

  function install(){
    ensureSections();
    $('#dayBriefReadMore')?.addEventListener('click',()=>{briefExpanded=!briefExpanded;render()});
    $('#showMoreConversations')?.addEventListener('click',()=>{conversationLimit+=3;render()});
    $('#askForm')?.addEventListener('submit',e=>{e.preventDefault();answer($('#askInput').value)});
    $$('.ask-suggestions button').forEach(b=>b.addEventListener('click',()=>{$('#askInput').value=b.textContent;answer(b.textContent)}));
    $$('.followup-tabs button').forEach(b=>b.addEventListener('click',()=>{$$('.followup-tabs button').forEach(x=>x.classList.toggle('active',x===b));renderFollowups(b.dataset.follow)}));
    document.addEventListener('click',e=>{const b=e.target.closest('.source-jump');if(b)jump(b.dataset.id,Number(b.dataset.offsetMs)||0);const p=e.target.closest('.person-card');if(p){root.SynapAsk?.open?root.SynapAsk.open(p.dataset.person):(()=>{location.hash='#ask';$('#askInput').value=p.dataset.person;answer(p.dataset.person)})()}});
    $('#datePicker')?.addEventListener('change',render);
    let refreshTimer=0;const scheduleRefresh=()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,80)};['synap-cloud-history-updated','synap-memory-ready','synap-transcript-updated','synap-recording-saved','synap-processing-complete'].forEach(name=>root.addEventListener(name,scheduleRefresh));
  }

  async function refresh(){const version=++refreshVersion;try{const loaded=await load();if(version!==refreshVersion)return;records=loaded;readError=false}catch(_){if(version!==refreshVersion)return;readError=true}render()}

  function render(){
    ensureSections();if(renderedDay!==selected()){renderedDay=selected();conversationLimit=3;briefExpanded=false;const container=$('#conversationList');if(container)container.replaceChildren()}
    const list=records.filter(r=>day(r.createdAt)===selected()).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),d=derive(list);renderBrief(list,d);
    if($('#decisionCount'))$('#decisionCount').textContent=d.decisions.length;if($('#commitmentCount'))$('#commitmentCount').textContent=d.my.length;if($('#waitingCount'))$('#waitingCount').textContent=d.waiting.length;
    if($('#decisionList'))$('#decisionList').innerHTML=rows(d.decisions,'decision');if($('#commitmentList'))$('#commitmentList').innerHTML=rows(d.my,'mine');if($('#waitingList'))$('#waitingList').innerHTML=rows(d.waiting,'waiting');
    if($('#conversationCount'))$('#conversationCount').textContent=d.conversations.length;
    renderConversations(d.conversations);
    const bits=[];if(d.conversations.length)bits.push(`${d.conversations.length} conversation${d.conversations.length===1?'':'s'}`);if(d.decisions.length)bits.push(`${d.decisions.length} decision${d.decisions.length===1?'':'s'}`);if(d.my.length)bits.push(`${d.my.length} commitment${d.my.length===1?'':'s'}`);const marked=highlights().filter(h=>day(h.createdAt)===selected()).length;if(marked)bits.push(`${marked} highlighted`);if($('#pulseLine'))$('#pulseLine').textContent=bits.length?bits.join(' · '):'Your decisions and next steps, together.';
    const chips=[...d.people.slice(0,4).map(x=>['person',x.name,x.role]),...d.topics.slice(0,5).map(x=>['topic',x[0],''])];if($('#contextChips')){$('#contextChips').innerHTML=chips.map(([k,v,role])=>`<button type="button" data-query="${esc(v)}"><span>${k==='person'?'@':'#'}</span>${esc(v)}${role&&role!=='unknown'?`<small>${esc(role)}</small>`:''}</button>`).join('');$$('#contextChips button').forEach(b=>b.addEventListener('click',()=>{root.SynapAsk?.open?root.SynapAsk.open(b.dataset.query):(()=>{location.hash='#ask';$('#askInput').value=b.dataset.query;answer(b.dataset.query)})()}))}
    if($('#peopleList')&&!root.SynapInteractionSurfaces)$('#peopleList').innerHTML=d.people.length?d.people.slice(0,8).map(p=>{const top=[...p.topics].sort((a,b)=>b[1]-a[1]).slice(0,2).map(x=>x[0]).join(' · '),open=d.waiting.filter(x=>String(x.owner).toLowerCase()===p.name.toLowerCase()).length;return`<button type="button" class="person-card" data-person="${esc(p.name)}"><span class="person-avatar">${esc(p.name.charAt(0).toUpperCase())}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.role&&p.role!=='unknown'?p.role:(top||p.count+' memories'))}</small>${open?`<em>${open} open follow-up${open>1?'s':''}</em>`:''}</span></button>`}).join(''):'<p class="brain-empty">People will appear after synap identifies them in processed conversations.</p>';
    if(!root.SynapInteractionSurfaces)renderFollowups($('.followup-tabs .active')?.dataset.follow||'mine');
  }

  function renderFollowups(mode){const scoped=records.filter(r=>day(r.createdAt)===selected()),d=derive(scoped),items=mode==='mine'?d.my:mode==='waiting'?d.waiting:[...d.my,...d.waiting];if($('#followupCount'))$('#followupCount').textContent=d.my.length+d.waiting.length;if($('#followupList'))$('#followupList').innerHTML=items.length?rows(items,mode==='mine'?'mine':'waiting'):'<p class="brain-empty">Nothing open right now.</p>'}
  function hay(r){const m=meeting(r),conv=conversationsOf(r).flatMap(c=>[c.title,c.summary,...(c.people||[]).map(p=>p.name),...(c.topics||[]),...(c.decisions||[]).map(textOf),...(c.action_items||[]).map(a=>[a.task,a.owner,a.due_date].join(' ')),...(c.follow_ups||[]).map(textOf)]),people=(m.people||[]).flatMap(p=>[p.name,p.role,p.evidence]),actions=actionEntries(r).map(({value:a})=>[a.task,a.owner,a.due_date].join(' ')),decisions=decisionEntries(r).map(x=>textOf(x.value)),followups=followUpEntries(r).map(x=>textOf(x.value));return[r.name,r.summary,r.transcript,m.executive_summary,...decisions,...actions,...followups,...topicsOf(r),...people,...conv].join(' ').toLowerCase()}
  function answer(q){q=String(q||'').trim();const out=$('#askAnswer');if(!out)return;if(!q){out.innerHTML='<p class="brain-empty">Ask a question about your memories.</p>';return}const lower=q.toLowerCase(),terms=lower.replace(/[^a-z0-9\s-]/g,' ').split(/\s+/).filter(x=>x.length>2&&!['what','when','where','about','from','with','this','that','have','did','who'].includes(x)),pool=/today/.test(lower)?records.filter(r=>day(r.createdAt)===today()):records,ranked=pool.map(r=>({r,s:terms.reduce((n,t)=>n+(hay(r).includes(t)?1:0),0)})).filter(x=>x.s>0||/decid|commit|waiting|follow|who/.test(lower)).sort((a,b)=>b.s-a.s||new Date(b.r.createdAt)-new Date(a.r.createdAt)).slice(0,6),facts=[];for(const{r}of ranked){const m=meeting(r);if(/who|person|people|spoke|talk/.test(lower)){for(const p of m.people||[])if(!mine(p.name))facts.push({r,text:p.name+(p.role&&p.role!=='unknown'?' · '+p.role:'')})}else if(/decid/.test(lower)){decisionEntries(r).forEach(x=>{const text=textOf(x.value);if(text)facts.push({r,text,startMs:sourceOffset(x.value,x.conversation)})})}else if(/commit|promis|action|todo/.test(lower)){actionEntries(r).filter(x=>mine(x.value?.owner)||!x.value?.owner).forEach(x=>facts.push({r,text:x.value.task+(x.value.due_date?' · '+x.value.due_date:''),startMs:sourceOffset(x.value,x.conversation)}))}else if(/waiting|follow|pending/.test(lower)){actionEntries(r).filter(x=>x.value?.owner&&!mine(x.value.owner)).forEach(x=>facts.push({r,text:x.value.task+' — '+x.value.owner,startMs:sourceOffset(x.value,x.conversation)}));followUpEntries(r).forEach(x=>{const t=textOf(x.value),owner=String(x.value?.owner||'').trim();if(t)facts.push({r,text:t+(owner&&!mine(owner)?' — '+owner:''),startMs:sourceOffset(x.value,x.conversation)})})}else{const cs=conversationsOf(r).filter(c=>terms.some(t=>[c.title,c.summary,...(c.people||[]).map(p=>p.name),...(c.topics||[])].join(' ').toLowerCase().includes(t)));if(cs.length)cs.forEach(c=>facts.push({r,text:(c.title?c.title+': ':'')+c.summary,startMs:sourceOffset(c)}));else{const t=m.executive_summary||r.summary||r.transcript;if(t)facts.push({r,text:String(t).replace(/\s+/g,' ').slice(0,280),startMs:0})}}}if(!facts.length){out.innerHTML='<p class="brain-empty">I could not find a grounded answer in your processed memories.</p>';return}out.innerHTML=`<div class="answer-copy"><span class="answer-mark">✦</span><div><strong>From your memory</strong>${facts.slice(0,6).map(f=>`<p>${esc(f.text)}</p>`).join('')}</div></div><div class="answer-sources"><span>Sources</span>${facts.slice(0,6).map(f=>`<button type="button" class="source-jump" data-id="${esc(f.r.id)}" data-offset-ms="${Math.max(0,Number(f.startMs)||0)}">${esc(f.r.name||'Conversation')} · ${esc(new Date(f.r.createdAt).toLocaleDateString([],{day:'numeric',month:'short'}))}</button>`).join('')}</div>`}
  function jump(id,offsetMs=0){if(root.SynapProvenance?.openSource)return root.SynapProvenance.openSource(id,offsetMs);const r=records.find(x=>String(x.id)===String(id));if(!r)return;const p=$('#datePicker');if(p){p.value=day(r.createdAt);p.dispatchEvent(new Event('change',{bubbles:true}))}if(root.SynapDashboardUI?.setView)root.SynapDashboardUI.setView('library',false);else location.hash='#library';setTimeout(()=>{const c=document.getElementById('recording-'+r.id);if(c){c.open=true;c.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'})}},250)}
  function init(){if(initialized)return;initialized=true;install();refresh()}
  root.SynapBrainUI={__singleton:true,derive,refresh,decisionEntries,actionEntries,followUpEntries,sourceOffset,summaryOf,conversationModel};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
