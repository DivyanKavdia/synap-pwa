/* Synap interaction surfaces: canonical People/follow-ups with grounded local fallback. */
(function(root){
'use strict';
const DB='dk-pendant-recordings';
const $=(s,h=document)=>h.querySelector(s),$$=(s,h=document)=>[...h.querySelectorAll(s)];
const mine=o=>/^(me|i|myself|self|you|user)$/i.test(String(o||'').trim());
let currentRecords=[],canonicalPeople=null,canonicalFollowups=null,canonicalAt=0,refreshing=false;
function day(v){const d=new Date(v);if(Number.isNaN(d.getTime()))return'';return[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
function selected(){return $('#datePicker')?.value||day(Date.now())}
function signedIn(){try{return Boolean(root.SynapAuth?.isSignedIn?.())}catch(_){return false}}
function sourceOffset(value,conversation){if(value?.start_ms!=null&&Number.isFinite(Number(value.start_ms)))return Number(value.start_ms);if(value?.start_seconds!=null&&Number.isFinite(Number(value.start_seconds)))return Number(value.start_seconds)*1000;if(conversation?.start_ms!=null&&Number.isFinite(Number(conversation.start_ms)))return Number(conversation.start_ms);if(conversation?.start_seconds!=null&&Number.isFinite(Number(conversation.start_seconds)))return Number(conversation.start_seconds)*1000;return 0}
function openDb(){return new Promise((res,rej)=>{const q=indexedDB.open(DB);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})}
async function load(){const db=await openDb();try{return await new Promise((res,rej)=>{const q=db.transaction('recordings').objectStore('recordings').getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>rej(q.error)})}finally{db.close()}}
function dedupeId(id){const nodes=$$('[id="'+id+'"]');nodes.slice(1).forEach(n=>n.remove());return nodes[0]||null}
function dedupe(){['followupInbox','peopleMemory','ask','followupList','peopleList','askForm','askInput','askAnswer'].forEach(dedupeId);const links=$$('.brain-tabs a[href="#ask"]');links.slice(1).forEach(n=>n.remove())}
function localRecord(id){return currentRecords.find(x=>String(x.id)===String(id))||null}
function showLibrary(){if(root.SynapDashboardUI?.setView)root.SynapDashboardUI.setView('library',false);else location.hash='#library'}
function openSource(id,ms=0){
  const offset=Math.max(0,Number(ms)||0);
  const finish=async()=>{currentRecords=await load().catch(()=>currentRecords);await root.SynapProvenance?.refresh?.();if(root.SynapProvenance?.openSource)return root.SynapProvenance.openSource(id,offset);const r=localRecord(id);if(!r)return false;const p=$('#datePicker');if(p){p.value=day(r.createdAt);p.dispatchEvent(new Event('change',{bubbles:true}))}showLibrary();return true};
  if(localRecord(id))return finish();
  if(root.SynapCloudHistory?.restoreRecording)return Promise.resolve(root.SynapCloudHistory.restoreRecording(id,false)).then(finish);
  return Promise.resolve(false);
}
function openAsk(person){dedupe();if(root.SynapAsk?.open){root.SynapAsk.open(person);return}if(root.SynapDashboardUI?.setView)root.SynapDashboardUI.setView('ask',false);else location.hash='#ask';const input=$('#askInput'),form=$('#askForm');if(input){input.value=person;input.focus({preventScroll:true})}if(form)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))}
function followEntries(r){const api=root.SynapBrainUI;if(!api)return[];const out=[];for(const entry of api.actionEntries?.(r)||[]){const a=entry.value||{},text=String(a.task||'').trim();if(!text)continue;const owner=String(a.owner||'').trim();out.push({r,text,owner,due:a.due_date||'',mine:mine(owner)||!owner,startMs:sourceOffset(a,entry.conversation),meta:[owner,a.due_date].filter(Boolean).join(' · ')})}for(const entry of api.followUpEntries?.(r)||[]){const v=entry.value||{},text=typeof v==='string'?v.trim():String(v.text||'').trim();if(!text)continue;const owner=String(v.owner||'').trim();out.push({r,text,owner,due:'',mine:mine(owner),startMs:sourceOffset(v,entry.conversation),meta:[owner,'Follow-up'].filter(Boolean).join(' · ')})}const seen=new Set();return out.filter(x=>{const k=x.r.id+'|'+x.startMs+'|'+x.text.toLowerCase();if(seen.has(k))return false;seen.add(k);return true})}
function canonicalFollowEntry(item){const ownerType=String(item?.owner?.type||'');return{id:String(item?.id||''),recordingId:String(item?.source?.recording_id||''),startMs:Math.max(0,Number(item?.source?.start_ms)||0),text:String(item?.task||'').trim(),owner:String(item?.owner?.display_name||''),due:item?.due_date||'',mine:ownerType==='self',meta:[item?.owner?.display_name,item?.due_date].filter(Boolean).join(' · ')}}
function makeSourceButton(x,kind){const b=document.createElement('button');b.type='button';b.className='brain-action-row source-jump';b.dataset.id=x.recordingId||x.r?.id||'';b.dataset.offsetMs=String(x.startMs||0);const icon=document.createElement('span');icon.className='brain-action-icon';icon.textContent=kind==='mine'?'→':'←';const copy=document.createElement('span'),strong=document.createElement('strong');strong.textContent=x.text;copy.appendChild(strong);if(x.meta){const small=document.createElement('small');small.textContent=x.meta;copy.appendChild(small)}b.append(icon,copy);return b}
function activeMode(){return $('.followup-tabs .active')?.dataset.follow||'mine'}
function followData(){if(Array.isArray(canonicalFollowups))return canonicalFollowups.map(canonicalFollowEntry).filter(x=>x.text&&x.recordingId);return currentRecords.filter(r=>day(r.createdAt)===selected()).flatMap(followEntries).map(x=>({...x,recordingId:x.r.id}))}
function renderFollowups(mode){const host=$('#followupList');if(!host)return;const entries=followData(),mineItems=entries.filter(x=>x.mine),waiting=entries.filter(x=>!x.mine),items=mode==='mine'?mineItems:mode==='waiting'?waiting:entries;const count=$('#followupCount');if(count)count.textContent=String(entries.length);host.replaceChildren();if(!items.length){const p=document.createElement('p');p.className='brain-empty';p.textContent='Nothing open right now.';host.appendChild(p);return}items.slice(0,30).forEach(x=>{if(x.id&&Array.isArray(canonicalFollowups)){const row=document.createElement('div');row.className='synap-follow-row';row.appendChild(makeSourceButton(x,x.mine?'mine':'waiting'));const done=document.createElement('button');done.type='button';done.className='synap-follow-done';done.dataset.followupId=x.id;done.textContent='Done';done.setAttribute('aria-label','Mark follow-up done');row.appendChild(done);host.appendChild(row)}else host.appendChild(makeSourceButton(x,x.mine?'mine':'waiting'))})}
const PEOPLE_PREVIEW_LIMIT=3;
let peopleExpanded=false,peopleQuery='',peopleRows=[];
function ensurePeopleControls(){
  const section=$('#peopleMemory'),heading=section&&$('.section-heading',section);
  if(!heading||$('#peopleBrowseToggle'))return;
  const title=$('h2',heading),copy=$('.section-copy',heading);
  if(copy)copy.textContent='The people in your conversations.';
  const count=document.createElement('span');count.id='peopleCount';count.className='count-badge';title?.append(' ',count);
  const toggle=document.createElement('button');toggle.id='peopleBrowseToggle';toggle.type='button';toggle.className='people-browse-toggle';
  toggle.setAttribute('aria-controls','peopleList peopleSearch');heading.appendChild(toggle);
  const search=document.createElement('label');search.id='peopleSearch';search.className='people-search';search.hidden=true;
  search.innerHTML='<span class="sr-only">Find a person</span><input type="search" placeholder="Find a person…" aria-label="Find a person" autocomplete="off">';
  heading.after(search);
  toggle.addEventListener('click',()=>{
    peopleExpanded=!peopleExpanded;
    if(!peopleExpanded){peopleQuery='';$('input',search).value='';}
    renderPeopleRows();
    if(peopleExpanded)$('input',search).focus({preventScroll:true});
  });
  $('input',search).addEventListener('input',event=>{peopleQuery=event.target.value.trim().toLowerCase();renderPeopleRows()});
}
function renderPeopleRows(){
  ensurePeopleControls();
  const host=$('#peopleList');if(!host)return;
  const section=$('#peopleMemory'),toggle=$('#peopleBrowseToggle'),count=$('#peopleCount'),search=$('#peopleSearch');
  if(count)count.textContent=String(peopleRows.length);
  if(toggle){toggle.hidden=peopleRows.length<=PEOPLE_PREVIEW_LIMIT&&!peopleExpanded;toggle.textContent=peopleExpanded?'Show less':'View all ('+peopleRows.length+')';toggle.setAttribute('aria-expanded',String(peopleExpanded));}
  if(search)search.hidden=!peopleExpanded;
  if(section)section.dataset.peopleExpanded=String(peopleExpanded);
  const matches=peopleRows.filter(person=>!peopleQuery||(person.name+' '+person.detail).toLowerCase().includes(peopleQuery));
  const shown=peopleExpanded?matches:matches.slice(0,PEOPLE_PREVIEW_LIMIT);
  host.replaceChildren();
  if(!shown.length){const empty=document.createElement('p');empty.className='brain-empty';empty.textContent=peopleRows.length?'No matching people. Try another name.':'People appear here after a conversation is processed.';host.appendChild(empty);return;}
  for(const person of shown){
    const button=document.createElement('button');button.type='button';button.className='person-card';button.dataset.person=person.name;
    if(person.id)button.dataset.personId=person.id;
    button.setAttribute('aria-label','Recall conversations with '+person.name);
    const avatar=document.createElement('span');avatar.className='person-avatar';avatar.textContent=person.name.charAt(0).toUpperCase();avatar.setAttribute('aria-hidden','true');
    const copy=document.createElement('span'),name=document.createElement('strong'),detail=document.createElement('small');
    name.textContent=person.name;detail.textContent=person.detail;copy.append(name,detail);
    if(person.open){const open=document.createElement('em');open.textContent=person.open+' open follow-up'+(person.open===1?'':'s');copy.appendChild(open);}
    button.append(avatar,copy);host.appendChild(button);
  }
  root.SynapPeopleConfirmUI?.decorate?.();
}
function renderCanonicalPeople(list){
  peopleRows=(list||[]).filter(p=>p?.name&&!mine(p.name)).slice().sort((a,b)=>new Date(b.last_interaction_at||0)-new Date(a.last_interaction_at||0))
    .map(p=>({name:p.name,id:p.person_id||'',detail:p.role&&p.role!=='unknown'?p.role:(p.conversation_count||0)+' memor'+(p.conversation_count===1?'y':'ies')}));
  renderPeopleRows();
}
function renderLocalPeople(list){
  const api=root.SynapBrainUI;if(!api?.derive)return;
  const data=api.derive(list);
  peopleRows=(data.people||[]).map(p=>({
    name:p.name,detail:p.role&&p.role!=='unknown'?p.role:([...p.topics].sort((a,b)=>b[1]-a[1]).slice(0,2).map(x=>x[0]).join(' · ')||p.count+' memories'),
    open:(data.waiting||[]).filter(x=>String(x.owner||'').toLowerCase()===p.name.toLowerCase()).length
  }));
  renderPeopleRows();
}
async function loadCanonical(force=false){const api=root.SynapBackend;if(!signedIn()||!api)return false;if(!force&&canonicalAt&&Date.now()-canonicalAt<15000&&canonicalPeople&&canonicalFollowups)return true;const [p,f]=await Promise.allSettled([api.people?.(),api.followUps?.('open','all')]);if(p.status==='fulfilled'&&Array.isArray(p.value?.people))canonicalPeople=p.value.people;if(f.status==='fulfilled'&&Array.isArray(f.value?.follow_ups))canonicalFollowups=f.value.follow_ups;if(canonicalPeople||canonicalFollowups)canonicalAt=Date.now();return Boolean(canonicalPeople||canonicalFollowups)}
async function refresh(forceCanonical=false){if(refreshing)return;refreshing=true;try{dedupe();currentRecords=await load().catch(()=>[]);await loadCanonical(forceCanonical);const list=currentRecords.filter(r=>day(r.createdAt)===selected());if(Array.isArray(canonicalPeople))renderCanonicalPeople(canonicalPeople);else renderLocalPeople(list);renderFollowups(activeMode());root.SynapPeopleConfirmUI?.decorate?.()}finally{refreshing=false}}
async function markDone(id,button){const api=root.SynapBackend;if(!id||!api?.resolveFollowUp)return;button.disabled=true;const old=button.textContent;button.textContent='Saving…';try{await api.resolveFollowUp(id,'done');if(Array.isArray(canonicalFollowups))canonicalFollowups=canonicalFollowups.filter(x=>String(x.id)!==String(id));renderFollowups(activeMode());root.dispatchEvent?.(new CustomEvent('synap-follow-up-updated',{detail:{id,state:'done'}}))}catch(error){button.disabled=false;button.textContent=old;console.warn('[synap follow-up]',error)}}
function recordingForInsight(card){const id=card?.dataset?.recordingId;if(id)return id;const dt=card?.querySelector('time')?.dateTime;if(!dt)return'';const target=new Date(dt).getTime();return currentRecords.find(r=>new Date(r.createdAt).getTime()===target)?.id||''}
function bind(){
  document.addEventListener('click',event=>{
    const done=event.target.closest?.('.synap-follow-done');if(done){event.preventDefault();event.stopImmediatePropagation();markDone(done.dataset.followupId,done);return}
    const person=event.target.closest?.('.person-card');if(person){event.preventDefault();event.stopImmediatePropagation();openAsk(person.dataset.person||'');return}
    const tab=event.target.closest?.('.followup-tabs button[data-follow]');if(tab){event.preventDefault();event.stopImmediatePropagation();$$('.followup-tabs button').forEach(x=>x.classList.toggle('active',x===tab));renderFollowups(tab.dataset.follow);return}
    const insight=event.target.closest?.('.insight-open');if(insight){const id=recordingForInsight(insight.closest('.insight-card'));if(id){event.preventDefault();event.stopImmediatePropagation();openSource(id,0)}return}
    const top=event.target.closest?.('.insight-card .insight-top');if(top&&top.tagName!=='SUMMARY'&&!event.target.closest?.('.synap-merge-check')){const id=recordingForInsight(top.closest('.insight-card'));if(id){event.preventDefault();openSource(id,0)}}
  },true);
  $('#datePicker')?.addEventListener('change',()=>setTimeout(()=>refresh(false),20));
  ['synap-memory-ready','synap-cloud-history-updated','synap-transcript-updated','synap-processing-complete'].forEach(n=>root.addEventListener(n,()=>{canonicalAt=0;setTimeout(()=>refresh(true),50)}));
  root.SynapAuth?.onChange?.(()=>{canonicalPeople=null;canonicalFollowups=null;canonicalAt=0;setTimeout(()=>refresh(true),20)});
}
function style(){if($('#synap-interaction-style'))return;const s=document.createElement('style');s.id='synap-interaction-style';s.textContent='.insight-card .insight-top{cursor:pointer}.person-card,.brain-action-row,.followup-tabs button{cursor:pointer}.synap-follow-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center}.synap-follow-done{border:1px solid var(--border,#d9e2ec);background:var(--surface,#fff);color:inherit;border-radius:9px;padding:6px 8px;font:inherit;font-size:10px;font-weight:750;cursor:pointer}.synap-follow-done:disabled{opacity:.55;cursor:wait}';document.head.appendChild(s)}
function init(){style();dedupe();bind();setTimeout(()=>refresh(true),80);setTimeout(()=>refresh(false),350)}
root.SynapInteractionSurfaces=Object.freeze({refresh,dedupe,renderFollowups,openAsk,openSource,loadCanonical});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
