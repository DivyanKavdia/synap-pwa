/* Product-facing simplification without hiding primary functionality. */
(function(){'use strict';
const $=id=>document.getElementById(id),DB='dk-pendant-recordings';
function text(node){return(node?.textContent||'').replace(/\s+/g,' ').trim()}
function renameButtons(root=document){root.querySelectorAll('button').forEach(b=>{const t=text(b).toLowerCase();if(t==='load audio'||t==='load recording'||t==='load')b.textContent='Play';else if(t==='download'||t==='download audio'||t==='download recording')b.textContent='Export';else if(t==='process'||t==='process recording'||t==='process memory'||t==='process queue')b.textContent='Create memory';else if(t==='process pending memories')b.textContent='Process now';else if(t==='retry storage')b.textContent='Retry save';else if(t==='recover')b.textContent='Recover audio'});}
function labelCheckbox(id,label){const input=$(id);if(!input)return;const wrap=input.closest('label');if(!wrap)return;for(const n of [...wrap.childNodes])if(n.nodeType===3&&n.textContent.trim())n.textContent=' '+label;}
function simplifySettings(){const form=$('settingsForm');if(!form)return;labelCheckbox('autoProcessInput','Create memories automatically');labelCheckbox('wakeLockInput','Keep screen awake while listening');labelCheckbox('autoReconnectInput','Reconnect automatically');const oldHint=$('appearanceAutoHint');if(oldHint)oldHint.remove();for(const id of ['retrySaveButton','recoveryButton','runQueueButton','pauseQueueButton']){const el=$(id);if(el){el.hidden=true;el.setAttribute('aria-hidden','true')}}const processing=$('processing');if(processing)processing.hidden=true;renameButtons(form)}

/* Old product-ui revisions moved almost every recording action into a tiny •••
   disclosure. runtime-ui then hid the remaining Play loader once audio started
   preparing, leaving cards that appeared to have no controls. Restore the
   original buttons in-place and keep the important actions visible. */
function restoreRecordingActions(actions){
  if(!actions)return;
  const old=actions.querySelector(':scope > .recording-more');
  if(old){
    const menu=old.querySelector('.recording-more-menu');
    if(menu){[...menu.children].forEach(node=>actions.insertBefore(node,old))}
    old.remove();
  }
  renameButtons(actions);
  actions.dataset.productized='visible';
  for(const button of [...actions.querySelectorAll(':scope > button')]){
    button.classList.remove('recording-primary-action');
    const label=text(button).toLowerCase();
    if(label==='create memory')button.classList.add('recording-action-memory');
    else if(label==='export')button.classList.add('recording-action-export');
    else if(label==='delete')button.classList.add('recording-action-delete');
    else if(label==='play')button.classList.add('recording-action-play');
  }
}
function simplifyLibrary(){
  const list=$('recordingsList');
  if(list){renameButtons(list);list.querySelectorAll('.recording-actions').forEach(restoreRecordingActions)}
  const clear=$('clearRecordingsButton');
  if(clear&&!clear.closest('.library-manage')){
    const wrap=document.createElement('details');wrap.className='library-manage';
    const summary=document.createElement('summary');summary.setAttribute('aria-label','Manage recordings');summary.textContent='•••';
    const menu=document.createElement('div');menu.className='library-manage-menu';
    clear.parentNode.insertBefore(wrap,clear);wrap.append(summary,menu);clear.textContent='Delete all recordings';menu.appendChild(clear);
  }
}

/* Critical product surfaces are singletons. Older cached bootstraps could inject
   brain-ui.js more than once; remove only duplicate copies, never the canonical
   node with its active handlers. */
function dedupeSelector(selector){const nodes=[...document.querySelectorAll(selector)];for(const node of nodes.slice(1))node.remove();return nodes.length>0?nodes[0]:null;}
function dedupeSingletons(){
  dedupeSelector('#ask');dedupeSelector('#followupInbox');dedupeSelector('#peopleMemory');
  const nav=document.querySelector('.brain-tabs');
  if(nav){const askLinks=[...nav.querySelectorAll('a[href="#ask"]')];for(const link of askLinks.slice(1))link.remove();const captureLinks=[...nav.querySelectorAll('a[href="#capture"]')];for(const link of captureLinks.slice(1))link.remove();}
}

/* Conversation cards distinguish attendance from subject matter. */
function localDay(value){const d=new Date(value);if(Number.isNaN(d.getTime()))return'';return[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
function loadRecordings(){return new Promise(resolve=>{try{const q=indexedDB.open(DB);q.onerror=()=>resolve([]);q.onsuccess=()=>{const db=q.result;try{const r=db.transaction('recordings').objectStore('recordings').getAll();r.onerror=()=>{db.close();resolve([])};r.onsuccess=()=>{const out=r.result||[];db.close();resolve(out)}}catch(_){db.close();resolve([])}}}catch(_){resolve([])}})}
function conversationsOf(recording){const m=recording?.meeting||{};const list=Array.isArray(m.conversations)&&m.conversations.length?m.conversations:recording?.conversations;return Array.isArray(list)?list:[]}
function startMs(conversation){if(Number.isFinite(Number(conversation?.start_ms)))return Math.max(0,Number(conversation.start_ms));if(Number.isFinite(Number(conversation?.start_seconds)))return Math.max(0,Number(conversation.start_seconds)*1000);return NaN}
function timeLabel(conversation,index,items){const ms=startMs(conversation);if(!Number.isFinite(ms))return'—';if(ms===0){const zeros=items.filter(item=>startMs(item.c)===0).length;return index===0?'Start':zeros>1?'—':'0:00'}const total=Math.floor(ms/1000);return`${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`}
function participantNames(conversation){const raw=Array.isArray(conversation?.participants)?conversation.participants:[];const seen=new Set(),out=[];for(const value of raw){let name=String(value||'').trim();if(!name)continue;if(name.toLowerCase()==='self')name='You';const key=name.toLowerCase();if(seen.has(key))continue;seen.add(key);out.push(name)}return out}
async function smartConversations(){
  const list=$('conversationList');if(!list)return;
  const selected=$('datePicker')?.value||localDay(Date.now()),records=await loadRecordings();
  const items=[];for(const r of records.filter(x=>localDay(x.createdAt)===selected))for(const c of conversationsOf(r))items.push({r,c});
  items.sort((a,b)=>new Date(b.r.createdAt)-new Date(a.r.createdAt)||startMs(a.c)-startMs(b.c));
  const rows=[...list.querySelectorAll('.conversation-card')];
  rows.forEach((row,index)=>{
    const item=items[index];if(!item)return;
    const time=row.querySelector('.conversation-time');if(time)time.textContent=timeLabel(item.c,index,items);
    const copy=row.querySelector('span:last-child');if(!copy)return;
    copy.querySelectorAll('small').forEach(node=>node.remove());
    const participants=participantNames(item.c);
    if(participants.length){const p=document.createElement('small');p.className='conversation-participants';p.textContent='With '+participants.join(', ');copy.appendChild(p)}
    const summary=document.createElement('small');summary.className='conversation-smart-summary';summary.textContent=String(item.c.summary||'Conversation captured.').trim();copy.appendChild(summary);
  });
}
let conversationTimer=0;function scheduleSmartConversations(delay=120){clearTimeout(conversationTimer);conversationTimer=setTimeout(()=>smartConversations().catch(()=>{}),delay)}

function injectStyle(){
  if($('productUiStyle'))return;
  const s=document.createElement('style');s.id='productUiStyle';
  s.textContent=`
.settings-help{margin:8px 0 0;color:var(--muted);font-size:12px;line-height:1.45}
.product-advanced{margin-top:14px!important;padding:0!important;overflow:hidden}.product-advanced>summary{min-height:52px;display:flex;align-items:center;padding:0 14px;font-size:14px;font-weight:700;cursor:pointer}.product-advanced-body{padding:0 14px 14px;display:flex;gap:8px;flex-wrap:wrap}.product-advanced-body p{width:100%;margin:0 0 4px;color:var(--muted);font-size:12px;line-height:1.45}.product-advanced-body button{flex:1;min-width:120px}
.recording-actions{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));align-items:center!important;gap:8px!important;margin-top:10px}.recording-actions>button{display:inline-flex!important;min-width:0!important;width:100%!important;min-height:42px!important;padding:9px 10px!important;font-size:12px!important}.recording-actions .recording-action-memory{background:var(--accent-soft)!important;color:var(--accent)!important;border-color:color-mix(in srgb,var(--accent) 24%,var(--border))!important}.recording-actions .recording-action-delete{color:var(--rose)!important}.recording-actions .recording-action-play[aria-hidden="true"],.recording-actions .recording-action-play[hidden]{display:none!important}
.library-manage{position:relative;margin-left:auto;align-self:flex-start}.library-manage>summary{list-style:none;display:grid;place-items:center;width:42px;height:42px;border:1px solid var(--border);border-radius:12px;background:var(--surface);font-size:18px;font-weight:800;cursor:pointer}.library-manage>summary::-webkit-details-marker{display:none}.library-manage-menu{position:absolute;right:0;top:48px;z-index:20;min-width:178px;padding:6px;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:0 12px 34px rgba(0,0,0,.16);display:grid;gap:4px}.library-manage-menu button{width:100%;text-align:left;justify-content:flex-start!important;background:transparent!important;border:0!important;box-shadow:none!important;min-height:40px!important;padding:9px 10px!important}.library-manage:not([open]) .library-manage-menu{display:none}.library-manage #clearRecordingsButton{color:var(--rose)!important}.recording-card audio{width:100%;margin-top:8px}.conversation-card .conversation-participants{color:var(--accent);font-weight:700}.conversation-card .conversation-smart-summary{color:var(--muted)}
@media(max-width:430px){.recording-actions{grid-template-columns:repeat(2,minmax(0,1fr))}.recording-actions>button{font-size:12px!important}}
`;
  document.head.appendChild(s);
}
function init(){
  if(document.documentElement.dataset.synapProductUi==='1')return;document.documentElement.dataset.synapProductUi='1';
  injectStyle();dedupeSingletons();simplifySettings();simplifyLibrary();
  const target=$('recordingsList')||document.body;
  new MutationObserver(()=>simplifyLibrary()).observe(target,{childList:true,subtree:true});
  const main=document.querySelector('main');if(main)new MutationObserver(()=>dedupeSingletons()).observe(main,{childList:true});
  $('datePicker')?.addEventListener('change',()=>scheduleSmartConversations(80));
  ['synap-cloud-history-updated','synap-memory-ready','synap-transcript-updated'].forEach(name=>addEventListener(name,()=>scheduleSmartConversations(160)));
  scheduleSmartConversations(350);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
