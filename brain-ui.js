/* Synap second-brain UX: highlights, people memory, follow-up inbox and grounded recall. */
(function(root){
  'use strict';

  const DB='dk-pendant-recordings';
  const HKEY='synap-memory-highlights';
  let records=[];

  const $=s=>document.querySelector(s);
  const $$=s=>[...document.querySelectorAll(s)];
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const day=v=>{
    const d=new Date(v);
    return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  };
  const today=()=>day(Date.now());
  const mine=o=>/^(me|i|myself|self|you|user)$/i.test(String(o||'').trim());
  const fmt=v=>new Date(v).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});

  function highlights(){try{return JSON.parse(localStorage.getItem(HKEY)||'[]')}catch(_){return[]}}
  function saveHighlights(v){try{localStorage.setItem(HKEY,JSON.stringify(v.slice(-500)))}catch(_){}}
  function openDb(){return new Promise((res,rej)=>{const r=indexedDB.open(DB);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
  async function load(){
    const db=await openDb();
    try{
      return await new Promise((res,rej)=>{
        const r=db.transaction('recordings').objectStore('recordings').getAll();
        r.onsuccess=()=>res(r.result||[]);
        r.onerror=()=>rej(r.error);
      });
    }finally{db.close()}
  }

  function selected(){return $('#datePicker')?.value||today()}
  function meeting(r){return r?.meeting||{}}
  function conversationsOf(r){
    const m=meeting(r);
    const list=Array.isArray(m.conversations)&&m.conversations.length?m.conversations:r?.conversations;
    return Array.isArray(list)?list:[];
  }
  function textOf(value){
    if(value==null)return'';
    if(typeof value==='string')return value.trim();
    if(typeof value.text==='string')return value.text.trim();
    return'';
  }
  function dedupe(items,keyFn){
    const seen=new Set(),out=[];
    for(const item of items||[]){
      const key=keyFn(item);
      if(!key||seen.has(key))continue;
      seen.add(key);out.push(item);
    }
    return out;
  }
  function decisionEntries(r){
    const m=meeting(r),all=[];
    for(const x of m.decisions||[])all.push({value:x,conversation:null});
    for(const c of conversationsOf(r))for(const x of c.decisions||[])all.push({value:x,conversation:c});
    return dedupe(all,x=>{
      const t=textOf(x.value).toLowerCase();
      const start=Number(x.value?.start_ms??x.conversation?.start_ms??x.conversation?.start_seconds??0);
      return t?t+'|'+start:'';
    });
  }
  function actionEntries(r){
    const m=meeting(r),all=[];
    for(const x of m.action_items||[])all.push({value:x,conversation:null});
    for(const c of conversationsOf(r))for(const x of c.action_items||[])all.push({value:x,conversation:c});
    return dedupe(all,x=>{
      const a=x.value||{},task=String(a.task||'').trim().toLowerCase();
      const start=Number(a.start_ms??x.conversation?.start_ms??x.conversation?.start_seconds??0);
      return task?task+'|'+String(a.owner||'').trim().toLowerCase()+'|'+start:'';
    });
  }
  function followUpEntries(r){
    const m=meeting(r),all=[];
    for(const x of m.follow_ups||[])all.push({value:x,conversation:null});
    for(const c of conversationsOf(r))for(const x of c.follow_ups||[])all.push({value:x,conversation:c});
    return dedupe(all,x=>{
      const t=textOf(x.value).toLowerCase();
      const owner=String(x.value?.owner||'').trim().toLowerCase();
      const start=Number(x.value?.start_ms??x.conversation?.start_ms??x.conversation?.start_seconds??0);
      return t?t+'|'+owner+'|'+start:'';
    });
  }
  function topicsOf(r){
    const m=meeting(r),all=[...(m.topics||[])];
    for(const c of conversationsOf(r))all.push(...(c.topics||[]));
    return [...new Set(all.map(x=>String(x||'').trim()).filter(Boolean))];
  }

  function rows(items,kind){
    if(!items.length)return'<p class="brain-empty">Nothing detected yet.</p>';
    return items.slice(0,6).map(x=>`<button class="brain-action-row source-jump" data-id="${esc(x.r.id)}"><span class="brain-action-icon">${kind==='decision'?'✓':kind==='mine'?'→':'←'}</span><span><strong>${esc(x.text)}</strong>${x.meta?`<small>${esc(x.meta)}</small>`:''}</span></button>`).join('');
  }

  function derive(list){
    const decisions=[],my=[],waiting=[],topics=new Map(),people=new Map(),conversations=[];
    for(const r of list||[]){
      const m=meeting(r);

      for(const entry of decisionEntries(r)){
        const text=textOf(entry.value);
        if(!text)continue;
        decisions.push({r,text,meta:entry.conversation?.title||r.name||fmt(r.createdAt)});
      }

      for(const entry of actionEntries(r)){
        const a=entry.value||{},task=String(a.task||'').trim();
        if(!task)continue;
        const owner=String(a.owner||'').trim(),due=a.due_date||'';
        const item={r,text:task,owner,due,meta:[owner,due].filter(Boolean).join(' · ')};
        (mine(owner)||!owner?my:waiting).push(item);
      }

      for(const entry of followUpEntries(r)){
        const text=textOf(entry.value);
        if(!text)continue;
        const owner=String(entry.value?.owner||'').trim();
        const item={r,text,owner,due:'',meta:[owner,'Follow-up'].filter(Boolean).join(' · ')};
        (mine(owner)?my:waiting).push(item);
      }

      for(const t of topicsOf(r))topics.set(t,(topics.get(t)||0)+1);

      for(const p of m.people||r.people||[]){
        if(!p?.name||mine(p.name))continue;
        const k=p.name.trim().toLowerCase();
        const old=people.get(k)||{name:p.name,count:0,role:p.role||'',evidence:[],records:new Map(),topics:new Map(),last:0};
        old.count++;
        if(p.role&&!old.role)old.role=p.role;
        if(p.evidence&&!old.evidence.includes(p.evidence))old.evidence.push(p.evidence);
        old.records.set(r.id,r);
        old.last=Math.max(old.last,new Date(r.createdAt).getTime());
        for(const t of topicsOf(r))old.topics.set(t,(old.topics.get(t)||0)+1);
        people.set(k,old);
      }

      for(const c of conversationsOf(r))conversations.push({r,c});
    }
    return{
      decisions,
      my,
      waiting,
      topics:[...topics].sort((a,b)=>b[1]-a[1]),
      people:[...people.values()].sort((a,b)=>b.last-a.last),
      conversations:conversations.sort((a,b)=>new Date(b.r.createdAt)-new Date(a.r.createdAt)||Number(a.c.start_ms??a.c.start_seconds??0)-Number(b.c.start_ms??b.c.start_seconds??0))
    };
  }

  function install(){
    const brief=$('.day-brief'),glance=brief?.querySelector('.glance-grid');
    if(brief&&glance&&!$('#actionableMemory')){
      const n=document.createElement('div');
      n.id='actionableMemory';
      n.className='actionable-memory';
      n.innerHTML='<div class="memory-pulse"><div><span class="pulse-label">TODAY AT A GLANCE</span><strong id="pulseLine">synap is building your day.</strong></div><div class="pulse-actions"><button id="rememberThis" class="remember-pill" type="button">★ Remember this</button><button id="openAsk" class="ask-pill" type="button">Ask synap ↗</button></div></div><div class="action-grid"><section><header><span>Decisions</span><b id="decisionCount">0</b></header><div id="decisionList"></div></section><section><header><span>My commitments</span><b id="commitmentCount">0</b></header><div id="commitmentList"></div></section><section><header><span>Waiting on</span><b id="waitingCount">0</b></header><div id="waitingList"></div></section></div><div id="contextChips" class="context-chips"></div><section class="conversation-lane"><header><span>Conversations</span><b id="conversationCount">0</b></header><div id="conversationList" class="conversation-list"></div></section>';
      brief.insertBefore(n,glance);
      glance.classList.add('secondary-metrics');
    }

    const insights=$('#insights');
    if(insights){
      const inbox=document.createElement('section');
      inbox.id='followupInbox';inbox.className='section-card followup-inbox';
      inbox.innerHTML='<div class="section-heading"><div><p class="section-eyebrow">FOLLOW THROUGH</p><h2>Follow-up inbox <span id="followupCount" class="count-badge">0</span></h2><p class="section-copy">What you owe, what others owe you, and what still needs closure.</p></div></div><div class="followup-tabs"><button data-follow="mine" class="active">You owe</button><button data-follow="waiting">Waiting on</button><button data-follow="all">All</button></div><div id="followupList"></div>';
      insights.after(inbox);
      const people=document.createElement('section');
      people.id='peopleMemory';people.className='section-card people-memory';
      people.innerHTML='<div class="section-heading"><div><p class="section-eyebrow">PEOPLE MEMORY</p><h2>People</h2><p class="section-copy">Who you spoke with, what you discussed, and what remains open.</p></div></div><div id="peopleList" class="people-grid"></div>';
      inbox.after(people);
    }

    const library=$('#library');
    if(library){
      const ask=document.createElement('section');
      ask.id='ask';ask.className='section-card ask-synap';
      ask.innerHTML='<div class="ask-head"><span class="ask-orb">✦</span><div><p class="section-eyebrow">RECALL</p><h2>Ask synap</h2><p class="section-copy">Ask about people, conversations, decisions or commitments. Every answer links to its source.</p></div></div><form id="askForm" class="ask-form"><input id="askInput" type="search" autocomplete="off" placeholder="What did Ankit say about the launch?"><button type="submit">Ask</button></form><div class="ask-suggestions"><button type="button">What did I decide today?</button><button type="button">Who did I speak with today?</button><button type="button">What am I waiting on?</button></div><div id="askAnswer" class="ask-answer" aria-live="polite"><p class="brain-empty">Your answers will cite the conversations they came from.</p></div>';
      library.before(ask);
    }

    const nav=$('.brain-tabs');
    if(nav&&!nav.querySelector('a[href="#ask"]')){
      const a=document.createElement('a');
      a.href='#ask';
      a.innerHTML='<svg viewBox="0 0 24 24"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/></svg><span>Ask</span>';
      nav.insertBefore(a,nav.querySelector('a[href="#library"]'));
    }

    $('#rememberThis')?.addEventListener('click',mark);
    $('#openAsk')?.addEventListener('click',()=>{location.hash='#ask';setTimeout(()=>$('#askInput')?.focus(),100)});
    $('#askForm')?.addEventListener('submit',e=>{e.preventDefault();answer($('#askInput').value)});
    $$('.ask-suggestions button').forEach(b=>b.addEventListener('click',()=>{$('#askInput').value=b.textContent;answer(b.textContent)}));
    $$('.followup-tabs button').forEach(b=>b.addEventListener('click',()=>{$$('.followup-tabs button').forEach(x=>x.classList.toggle('active',x===b));renderFollowups(b.dataset.follow)}));
    document.addEventListener('click',e=>{
      const b=e.target.closest('.source-jump');if(b)jump(b.dataset.id);
      const p=e.target.closest('.person-card');if(p){location.hash='#ask';$('#askInput').value=p.dataset.person;answer(p.dataset.person)}
    });
    $('#datePicker')?.addEventListener('change',render);

    let refreshTimer=0;
    const scheduleRefresh=()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,80)};
    ['synap-cloud-history-updated','synap-memory-ready','synap-transcript-updated'].forEach(name=>root.addEventListener(name,scheduleRefresh));
  }

  function mark(){
    const active=document.body.dataset.deviceState==='2';
    const r=records.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];
    const elapsed=active&&r?Math.max(0,(Date.now()-new Date(r.createdAt).getTime())/1000):null;
    const h={id:crypto.randomUUID?.()||String(Date.now()),createdAt:new Date().toISOString(),recordingId:r?.id||null,offsetSeconds:elapsed,source:active?'live-capture':'manual'};
    const hs=highlights();hs.push(h);saveHighlights(hs);
    const b=$('#rememberThis');
    if(b){const old=b.textContent;b.textContent='✓ Remembered';b.classList.add('remembered');setTimeout(()=>{b.textContent=old;b.classList.remove('remembered')},1600)}
    root.dispatchEvent(new CustomEvent('synap-memory-highlight',{detail:h}));
  }

  async function refresh(){records=await load().catch(()=>[]);render()}

  function render(){
    const list=records.filter(r=>day(r.createdAt)===selected()),d=derive(list);
    if($('#decisionCount'))$('#decisionCount').textContent=d.decisions.length;
    if($('#commitmentCount'))$('#commitmentCount').textContent=d.my.length;
    if($('#waitingCount'))$('#waitingCount').textContent=d.waiting.length;
    if($('#decisionList'))$('#decisionList').innerHTML=rows(d.decisions,'decision');
    if($('#commitmentList'))$('#commitmentList').innerHTML=rows(d.my,'mine');
    if($('#waitingList'))$('#waitingList').innerHTML=rows(d.waiting,'waiting');
    if($('#conversationCount'))$('#conversationCount').textContent=d.conversations.length;
    if($('#conversationList'))$('#conversationList').innerHTML=d.conversations.length
      ?d.conversations.slice(0,8).map(({r,c})=>`<button class="conversation-card source-jump" data-id="${esc(r.id)}"><span class="conversation-time">${esc((c.start_ms!=null?Math.floor(c.start_ms/60000):c.start_seconds!=null?Math.floor(c.start_seconds/60):'')+(c.start_ms!=null||c.start_seconds!=null?'m':''))}</span><span><strong>${esc(c.title||'Conversation')}</strong><small>${esc((c.people||[]).map(p=>p.name).filter(Boolean).join(', ')||c.summary||'')}</small></span></button>`).join('')
      :'<p class="brain-empty">Newly processed memories will be separated into real conversations here.</p>';

    const bits=[];
    if(d.conversations.length)bits.push(`${d.conversations.length} conversations`);
    if(d.decisions.length)bits.push(`${d.decisions.length} decisions`);
    if(d.my.length)bits.push(`${d.my.length} commitments`);
    const marked=highlights().filter(h=>day(h.createdAt)===selected()).length;
    if(marked)bits.push(`${marked} highlighted`);
    if($('#pulseLine'))$('#pulseLine').textContent=bits.length?bits.join(' · '):'When synap understands a conversation, your decisions and commitments appear here.';

    const chips=[...d.people.slice(0,4).map(x=>['person',x.name,x.role]),...d.topics.slice(0,5).map(x=>['topic',x[0],''])];
    if($('#contextChips')){
      $('#contextChips').innerHTML=chips.map(([k,v,role])=>`<button type="button" data-query="${esc(v)}"><span>${k==='person'?'@':'#'}</span>${esc(v)}${role&&role!=='unknown'?`<small>${esc(role)}</small>`:''}</button>`).join('');
      $$('#contextChips button').forEach(b=>b.addEventListener('click',()=>{location.hash='#ask';$('#askInput').value=b.dataset.query;answer(b.dataset.query)}));
    }

    if($('#peopleList'))$('#peopleList').innerHTML=d.people.length
      ?d.people.slice(0,8).map(p=>{
        const top=[...p.topics].sort((a,b)=>b[1]-a[1]).slice(0,2).map(x=>x[0]).join(' · ');
        const open=d.waiting.filter(x=>String(x.owner).toLowerCase()===p.name.toLowerCase()).length;
        return`<button class="person-card" data-person="${esc(p.name)}"><span class="person-avatar">${esc(p.name.charAt(0).toUpperCase())}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.role&&p.role!=='unknown'?p.role:(top||p.count+' memories'))}</small>${open?`<em>${open} open follow-up${open>1?'s':''}</em>`:''}</span></button>`;
      }).join('')
      :'<p class="brain-empty">People will appear after synap identifies them in processed conversations.</p>';

    renderFollowups($('.followup-tabs .active')?.dataset.follow||'mine');
  }

  function renderFollowups(mode){
    const scoped=records.filter(r=>day(r.createdAt)===selected());
    const d=derive(scoped),items=mode==='mine'?d.my:mode==='waiting'?d.waiting:[...d.my,...d.waiting];
    if($('#followupCount'))$('#followupCount').textContent=d.my.length+d.waiting.length;
    if($('#followupList'))$('#followupList').innerHTML=items.length?rows(items,mode==='mine'?'mine':'waiting'):'<p class="brain-empty">Nothing open right now.</p>';
  }

  function hay(r){
    const m=meeting(r);
    const conv=conversationsOf(r).flatMap(c=>[
      c.title,c.summary,
      ...(c.people||[]).map(p=>p.name),
      ...(c.topics||[]),
      ...(c.decisions||[]).map(textOf),
      ...(c.action_items||[]).map(a=>[a.task,a.owner,a.due_date].join(' ')),
      ...(c.follow_ups||[]).map(textOf)
    ]);
    const people=(m.people||[]).flatMap(p=>[p.name,p.role,p.evidence]);
    const actions=actionEntries(r).map(({value:a})=>[a.task,a.owner,a.due_date].join(' '));
    const decisions=decisionEntries(r).map(x=>textOf(x.value));
    const followups=followUpEntries(r).map(x=>textOf(x.value));
    return[r.name,r.summary,r.transcript,m.executive_summary,...decisions,...actions,...followups,...topicsOf(r),...people,...conv].join(' ').toLowerCase();
  }

  function answer(q){
    q=String(q||'').trim();
    const out=$('#askAnswer');
    if(!out)return;
    if(!q){out.innerHTML='<p class="brain-empty">Ask a question about your memories.</p>';return}

    const lower=q.toLowerCase();
    const terms=lower.replace(/[^a-z0-9\s-]/g,' ').split(/\s+/).filter(x=>x.length>2&&!['what','when','where','about','from','with','this','that','have','did','who'].includes(x));
    const pool=/today/.test(lower)?records.filter(r=>day(r.createdAt)===today()):records;
    const ranked=pool.map(r=>({r,s:terms.reduce((n,t)=>n+(hay(r).includes(t)?1:0),0)}))
      .filter(x=>x.s>0||/decid|commit|waiting|follow|who/.test(lower))
      .sort((a,b)=>b.s-a.s||new Date(b.r.createdAt)-new Date(a.r.createdAt))
      .slice(0,6);
    const facts=[];

    for(const {r} of ranked){
      const m=meeting(r);
      if(/who|person|people|spoke|talk/.test(lower)){
        for(const p of m.people||[])if(!mine(p.name))facts.push({r,text:p.name+(p.role&&p.role!=='unknown'?' · '+p.role:'')});
      }else if(/decid/.test(lower)){
        decisionEntries(r).forEach(x=>{const text=textOf(x.value);if(text)facts.push({r,text})});
      }else if(/commit|promis|action|todo/.test(lower)){
        actionEntries(r).map(x=>x.value).filter(a=>mine(a.owner)||!a.owner).forEach(a=>facts.push({r,text:a.task+(a.due_date?' · '+a.due_date:'')}));
      }else if(/waiting|follow|pending/.test(lower)){
        actionEntries(r).map(x=>x.value).filter(a=>a.owner&&!mine(a.owner)).forEach(a=>facts.push({r,text:a.task+' — '+a.owner}));
        followUpEntries(r).forEach(x=>{
          const t=textOf(x.value),owner=String(x.value?.owner||'').trim();
          if(t)facts.push({r,text:t+(owner&&!mine(owner)?' — '+owner:'')});
        });
      }else{
        const cs=conversationsOf(r).filter(c=>terms.some(t=>[c.title,c.summary,...(c.people||[]).map(p=>p.name),...(c.topics||[])].join(' ').toLowerCase().includes(t)));
        if(cs.length)cs.forEach(c=>facts.push({r,text:(c.title?c.title+': ':'')+c.summary}));
        else{
          const t=m.executive_summary||r.summary||r.transcript;
          if(t)facts.push({r,text:String(t).replace(/\s+/g,' ').slice(0,280)});
        }
      }
    }

    if(!facts.length){out.innerHTML='<p class="brain-empty">I could not find a grounded answer in your processed memories.</p>';return}
    out.innerHTML=`<div class="answer-copy"><span class="answer-mark">✦</span><div><strong>From your memory</strong>${facts.slice(0,6).map(f=>`<p>${esc(f.text)}</p>`).join('')}</div></div><div class="answer-sources"><span>Sources</span>${[...new Map(facts.map(f=>[f.r.id,f.r])).values()].slice(0,4).map(r=>`<button class="source-jump" data-id="${esc(r.id)}">${esc(r.name||'Conversation')} · ${esc(new Date(r.createdAt).toLocaleDateString([],{day:'numeric',month:'short'}))}</button>`).join('')}</div>`;
  }

  function jump(id){
    const r=records.find(x=>String(x.id)===String(id));if(!r)return;
    const p=$('#datePicker');
    if(p){p.value=day(r.createdAt);p.dispatchEvent(new Event('change',{bubbles:true}))}
    location.hash='#library';
    setTimeout(()=>{
      const c=document.getElementById('recording-'+r.id);
      if(c){
        c.open=true;
        c.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});
      }
    },250);
  }

  function bindMemoryEvents(){
    ['synap-memory-ready','synap-cloud-history-updated','synap-transcript-updated'].forEach(name=>{
      root.addEventListener?.(name,()=>setTimeout(refresh,20));
    });
  }

  function init(){install();bindMemoryEvents();refresh()}
  root.SynapBrainUI={derive,refresh,decisionEntries,actionEntries,followUpEntries};

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})(globalThis);
