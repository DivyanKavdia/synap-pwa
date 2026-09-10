/* Product-facing simplification without hiding primary functionality. */
(function(){'use strict';
const $=id=>document.getElementById(id);
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

function injectStyle(){
  if($('productUiStyle'))return;
  const s=document.createElement('style');s.id='productUiStyle';
  s.textContent=`
.recording-actions{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));align-items:center!important;gap:8px!important;margin-top:10px}.recording-actions>button{display:inline-flex!important;min-width:0!important;width:100%!important;min-height:42px!important;padding:9px 10px!important;font-size:12px!important}.recording-actions .recording-action-memory{background:var(--accent-soft)!important;color:var(--accent)!important;border-color:color-mix(in srgb,var(--accent) 24%,var(--border))!important}.recording-actions .recording-action-delete{color:var(--rose)!important}.recording-actions .recording-action-play[aria-hidden="true"],.recording-actions .recording-action-play[hidden]{display:none!important}
.library-manage{position:relative;margin-left:auto;align-self:flex-start}.library-manage>summary{list-style:none;display:grid;place-items:center;width:42px;height:42px;border:1px solid var(--border);border-radius:12px;background:var(--surface);font-size:18px;font-weight:800;cursor:pointer}.library-manage>summary::-webkit-details-marker{display:none}.library-manage-menu{position:absolute;right:0;top:48px;z-index:20;min-width:178px;padding:6px;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:0 12px 34px rgba(0,0,0,.16);display:grid;gap:4px}.library-manage-menu button{width:100%;text-align:left;justify-content:flex-start!important;background:transparent!important;border:0!important;box-shadow:none!important;min-height:40px!important;padding:9px 10px!important}.library-manage:not([open]) .library-manage-menu{display:none}.library-manage #clearRecordingsButton{color:var(--rose)!important}.recording-card audio{width:100%;margin-top:8px}
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
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
