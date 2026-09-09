/* Product-facing simplification layer. Keeps recovery/debug controls available without making them primary UX. */
(function(){'use strict';
const $=id=>document.getElementById(id),DB='dk-pendant-recordings';
function text(node){return(node?.textContent||'').replace(/\s+/g,' ').trim()}
function renameButtons(root=document){root.querySelectorAll('button').forEach(b=>{const t=text(b).toLowerCase();if(t==='load audio'||t==='load recording'||t==='load')b.textContent='Play';else if(t==='download'||t==='download audio'||t==='download recording')b.textContent='Export';else if(t==='process'||t==='process recording'||t==='process memory'||t==='process queue')b.textContent='Create memory';else if(t==='process pending memories')b.textContent='Process now';else if(t==='retry storage')b.textContent='Retry save';else if(t==='recover')b.textContent='Recover audio'});}
function labelCheckbox(id,label){const input=$(id);if(!input)return;const wrap=input.closest('label');if(!wrap)return;for(const n of [...wrap.childNodes])if(n.nodeType===3&&n.textContent.trim())n.textContent=' '+label;}
function simplifySettings(){const form=$('settingsForm');if(!form)return;labelCheckbox('autoProcessInput','Create memories automatically');labelCheckbox('wakeLockInput','Keep screen awake while listening');labelCheckbox('autoReconnectInput','Reconnect automatically');const oldHint=$('appearanceAutoHint');if(oldHint)oldHint.remove();for(const id of ['retrySaveButton','recoveryButton','runQueueButton','pauseQueueButton']){const el=$(id);if(el){el.hidden=true;el.setAttribute('aria-hidden','true')}}const processing=$('processing');if(processing)processing.hidden=true;renameButtons(form)}
function makeOverflow(actions){if(!actions||actions.dataset.productized==='1')return;renameButtons(actions);actions.dataset.productized='1';const buttons=[...actions.querySelectorAll(':scope > button')];const play=buttons.find(b=>/^play$/i.test(text(b)));const secondary=buttons.filter(b=>b!==play);if(play)play.classList.add('recording-primary-action');if(!secondary.length)return;const more=document.createElement('details');more.className='recording-more';const summary=document.createElement('summary');summary.setAttribute('aria-label','More recording actions');summary.textContent='•••';const menu=document.createElement('div');menu.className='recording-more-menu';secondary.forEach(b=>menu.appendChild(b));more.append(summary,menu);actions.appendChild(more);more.addEventListener('toggle',()=>{if(more.open)document.querySelectorAll('.recording-more[open]').forEach(x=>{if(x!==more)x.open=false})});}
function simplifyLibrary(){const list=$('recordingsList');if(list){renameButtons(list);list.querySelectorAll('.recording-actions').forEach(makeOverflow)}const clear=$('clearRecordingsButton');if(clear&&!clear.closest('.library-manage')){const wrap=document.createElement('details');wrap.className='library-manage';const summary=document.createElement('summary');summary.setAttribute('aria-label','Manage recordings');summary.textContent='•••';const menu=document.createElement('div');menu.className='library-manage-menu';clear.parentNode.insertBefore(wrap,clear);wrap.append(summary,menu);clear.textContent='Delete all recordings';menu.appendChild(clear)}}

/* Critical product surfaces are singletons. Older cached bootstraps could inject
   brain-ui.js in addition to the current static bootstrap, which allowed duplicate
   #ask / follow-up / people sections because their legacy creator was not
   idempotent. Keep the first canonical surface and remove only later duplicates. */
function dedupeSelector(selector){const nodes=[...document.querySelectorAll(selector)];for(const node of nodes.slice(1))node.remove();return nodes.length>0?nodes[0]:null;}
function dedupeSingletons(){
  dedupeSelector('#ask');
  dedupeSelector('#followupInbox');
  dedupeSelector('#peopleMemory');
  const nav=document.querySelector('.brain-tabs');
  if(nav){const askLinks=[...nav.querySelectorAll('a[href="#ask"]')];for(const link of askLinks.slice(1))link.remove();}
}

/* Conversation cards must distinguish attendance from subject matter. Legacy
   memories exposed only `people`, which may include someone merely discussed;
   never present that ambiguous field as "who was on the call". Memory schema v2
   supplies `participants` explicitly. Existing memories immediately fall back to
   their summary instead of showing a misleading list of names. */
function localDay(value){const d=new Date(value);if(Number.isNaN(d.getTime()))return'';return[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
function loadRecordings(){return new Promise(resolve=>{try{const q=indexedDB.open(DB);q.onerror=()=>resolve([]);q.onsuccess=()=>{const db=q.result;try{const r=db.transaction('recordings').objectStore('recordings').getAll();r.onerror=()=>{db.close();resolve([])};r.onsuccess=()=>{const out=r.result||[];db.close();resolve(out)}}catch(_){db.close();resolve([])}}}catch(_){resolve([])}})}
function conversationsOf(recording){const m=recording?.meeting||{};const list=Array.isArray(m.conversations)&&m.conversations.length?m.conversations:recording?.conversations;return Array.isArray(list)?list:[]}
function startMs(conversation){if(Number.isFinite(Number(conversation?.start_ms)))return Math.max(0,Number(conversation.start_ms));if(Number.isFinite(Number(conversation?.start_seconds)))return Math.max(0,Number(conversation.start_seconds)*1000);return NaN}
function timeLabel(conversation,index,items){const ms=startMs(conversation);if(!Number.isFinite(ms))return'—';if(ms===0){const zeros=items.filter(item=>startMs(item.c)===0).length;return index===0?'Start':zeros>1?'—':'0:00'}const total=Math.floor(ms/1000);return`${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`}
function participantNames(conversation){const raw=Array.isArray(conversation?.participants)?conversation.participants:[];const seen=new Set(),out=[];for(const value of raw){let name=String(value||'').trim();if(!name)continue;if(name.toLowerCase()==='self')name='You';const key=name.toLowerCase();if(seen.has(key))continue;seen.add(key);out.push(name)}return out}
async function smartConversations(){
  const list=$('conversationList');if(!list)return;
  const selected=$('datePicker')?.value||localDay(Date.now()),records=await loadRecordings();
  const items=[];
  for(const r of records.filter(x=>localDay(x.createdAt)===selected))for(const c of conversationsOf(r))items.push({r,c});
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
let conversationTimer=0;
function scheduleSmartConversations(delay=120){clearTimeout(conversationTimer);conversationTimer=setTimeout(()=>smartConversations().catch(()=>{}),delay)}

function injectStyle(){if($('productUiStyle'))return;const s=document.createElement('style');s.id='productUiStyle';s.textContent='.settings-help{margin:8px 0 0;color:var(--muted);font-size:12px;line-height:1.45}.product-advanced{margin-top:14px!important;padding:0!important;overflow:hidden}.product-advanced>summary{min-height:52px;display:flex;align-items:center;padding:0 14px;font-size:14px;font-weight:700;cursor:pointer}.product-advanced-body{padding:0 14px 14px;display:flex;gap:8px;flex-wrap:wrap}.product-advanced-body p{width:100%;margin:0 0 4px;color:var(--muted);font-size:12px;line-height:1.45}.product-advanced-body button{flex:1;min-width:120px}.recording-actions{display:flex!important;align-items:center!important;gap:8px!important}.recording-primary-action{min-width:88px}.recording-more,.library-manage{position:relative;margin-left:auto}.recording-more>summary,.library-manage>summary{list-style:none;display:grid;place-items:center;width:42px;height:42px;border:1px solid var(--border);border-radius:12px;background:var(--surface);font-size:18px;font-weight:800;cursor:pointer}.recording-more>summary::-webkit-details-marker,.library-manage>summary::-webkit-details-marker{display:none}.recording-more-menu,.library-manage-menu{position:absolute;right:0;top:48px;z-index:20;min-width:178px;padding:6px;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:0 12px 34px rgba(0,0,0,.16);display:grid;gap:4px}.recording-more-menu button,.library-manage-menu button{width:100%;text-align:left;justify-content:flex-start!important;background:transparent!important;border:0!important;box-shadow:none!important;min-height:40px!important;padding:9px 10px!important}.recording-more:not([open]) .recording-more-menu,.library-manage:not([open]) .library-manage-menu{display:none}.recording-card audio{width:100%;margin-top:8px}.library-manage{align-self:flex-start}.library-manage #clearRecordingsButton{color:var(--danger,#c43b3b)!important}.conversation-card .conversation-participants{color:var(--accent);font-weight:700}.conversation-card .conversation-smart-summary{color:var(--muted)}';document.head.appendChild(s)}
function init(){
  if(document.documentElement.dataset.synapProductUi==='1')return;document.documentElement.dataset.synapProductUi='1';
  injectStyle();
  dedupeSingletons();
  simplifySettings();
  simplifyLibrary();
  const target=$('recordingsList')||document.body;
  new MutationObserver(()=>simplifyLibrary()).observe(target,{childList:true,subtree:true});
  const main=document.querySelector('main');
  if(main)new MutationObserver(()=>dedupeSingletons()).observe(main,{childList:true});
  $('datePicker')?.addEventListener('change',()=>scheduleSmartConversations(80));
  ['synap-cloud-history-updated','synap-memory-ready','synap-transcript-updated'].forEach(name=>addEventListener(name,()=>scheduleSmartConversations(160)));
  scheduleSmartConversations(350);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();