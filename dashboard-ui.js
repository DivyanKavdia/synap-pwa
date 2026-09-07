/* Compact dashboard navigation and progressive disclosure for synap. */
(function(root){
  'use strict';
  const STYLE_ID='synapDashboardStyle';
  const VIEW_IDS={today:'#today',memories:'#insights',ask:'#ask',library:'#library'};
  const $=s=>document.querySelector(s);
  const $$=s=>[...document.querySelectorAll(s)];

  function injectStyle(){
    if(document.getElementById(STYLE_ID))return;
    const style=document.createElement('style');
    style.id=STYLE_ID;
    style.textContent=`
html,body{max-width:100%;overflow-x:clip}
.app-shell,main,.brain-home,.day-brief,.actionable-memory,.memory-pulse,.action-grid,.conversation-lane,.section-card{min-width:0;max-width:100%}
.brain-action-row>span:last-child,.conversation-card>span:last-child,.person-card>span:last-child{min-width:0;max-width:100%}
.brain-action-row strong,.brain-action-row small,.conversation-card strong,.conversation-card small{max-width:100%;overflow-wrap:anywhere}
.conversation-card small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.context-chips{max-width:100%;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
.today-collapse{margin:0;border:1px solid var(--border);border-radius:14px;background:var(--surface);overflow:hidden;min-width:0}
.today-collapse>summary{list-style:none;display:flex;align-items:center;gap:9px;min-height:46px;padding:0 12px;cursor:pointer;color:var(--text);font-size:12px;font-weight:760}
.today-collapse>summary::-webkit-details-marker{display:none}
.today-collapse-title{min-width:0;flex:1}
.today-collapse-meta{min-width:0;color:var(--muted);font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
.today-collapse-chevron{flex:0 0 auto;color:var(--muted);font-size:14px;transition:transform .16s ease}
.today-collapse[open] .today-collapse-chevron{transform:rotate(180deg)}
.today-collapse .action-grid{padding:0 8px 8px}
.today-collapse .conversation-lane{border:0;border-top:1px solid var(--border);border-radius:0;padding:5px 10px 8px;background:transparent}
.today-collapse .conversation-lane>header{display:none}
.today-collapse .conversation-list{min-width:0}
.day-brief-text.synap-clamped{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;margin-bottom:5px}
.day-brief-text.synap-expanded{-webkit-line-clamp:unset;display:block}
.day-brief-more{display:inline-flex;align-items:center;border:0;background:transparent;color:var(--accent);padding:2px 0 7px;font:inherit;font-size:11px;font-weight:720}
.today-memory-pipeline{min-width:0;max-width:100%;transition:none}
.today-memory-pipeline-head{cursor:pointer;min-height:26px;user-select:none}
.today-memory-pipeline-head:focus-visible{outline:2px solid #78baff;outline-offset:4px;border-radius:7px}
.today-memory-pipeline-toggle{flex:0 0 auto;margin-left:3px;color:#b9c8d9;font-size:12px;line-height:1;transition:transform .16s ease}
.today-memory-pipeline[data-collapsed="false"] .today-memory-pipeline-toggle{transform:rotate(180deg)}
.today-memory-pipeline[data-collapsed="true"]>.today-memory-pipeline-current,
.today-memory-pipeline[data-collapsed="true"]>.today-memory-track,
.today-memory-pipeline[data-collapsed="true"]>.today-memory-pipeline-link{display:none!important}
.today-memory-pipeline[data-collapsed="true"]{padding-top:9px;padding-bottom:9px}
.actionable-memory{gap:8px}
body[data-synap-view="today"] #insights,body[data-synap-view="today"] #followupInbox,body[data-synap-view="today"] #peopleMemory,body[data-synap-view="today"] #ask,body[data-synap-view="today"] #library{display:none!important}
body[data-synap-view="memories"] #today,body[data-synap-view="memories"] #ask,body[data-synap-view="memories"] #library{display:none!important}
body[data-synap-view="ask"] #today,body[data-synap-view="ask"] #insights,body[data-synap-view="ask"] #followupInbox,body[data-synap-view="ask"] #peopleMemory,body[data-synap-view="ask"] #library{display:none!important}
body[data-synap-view="library"] #today,body[data-synap-view="library"] #insights,body[data-synap-view="library"] #followupInbox,body[data-synap-view="library"] #peopleMemory,body[data-synap-view="library"] #ask{display:none!important}
body[data-synap-view] main>section:not(#today):not(#insights):not(#followupInbox):not(#peopleMemory):not(#ask):not(#library):not(#capture):not(#processing){display:none!important}
@media(max-width:430px){
  .day-brief{padding:13px!important}
  .memory-pulse{padding:10px 11px}
  .today-collapse>summary{min-height:44px;padding:0 10px}
  .today-collapse-meta{max-width:62%;font-size:10px}
  .today-collapse .action-grid{display:grid;grid-template-columns:1fr;padding:0 7px 7px;gap:6px}
  .today-collapse .action-grid>section{padding:8px 9px}
  .conversation-card{grid-template-columns:26px minmax(0,1fr);gap:7px;padding:8px 0}
  .context-chips{margin-left:-2px;margin-right:-2px;padding:0 2px 2px}
}
@media(min-width:760px){
  .app-shell{max-width:980px}
  .brain-home{max-width:860px;margin-inline:auto}
  body[data-synap-view="memories"] #insights,body[data-synap-view="memories"] #followupInbox,body[data-synap-view="memories"] #peopleMemory,
  body[data-synap-view="ask"] #ask,body[data-synap-view="library"] #library{max-width:860px;margin-left:auto!important;margin-right:auto!important}
}
`;
    document.head.appendChild(style);
  }

  function countText(id){return (document.getElementById(id)?.textContent||'0').trim()||'0'}

  function syncActionSummary(){
    const meta=document.getElementById('todayActionsMeta');
    if(!meta)return;
    meta.textContent=`${countText('decisionCount')} decisions · ${countText('commitmentCount')} commitments · ${countText('waitingCount')} waiting`;
  }

  function wrapActions(){
    const grid=$('#actionableMemory .action-grid');
    if(!grid||document.getElementById('todayActionsCollapse'))return;
    const details=document.createElement('details');
    details.id='todayActionsCollapse';details.className='today-collapse today-actions-collapse';
    const summary=document.createElement('summary');
    summary.innerHTML='<span class="today-collapse-title">Actions</span><span id="todayActionsMeta" class="today-collapse-meta"></span><span class="today-collapse-chevron" aria-hidden="true">⌄</span>';
    grid.parentNode.insertBefore(details,grid);details.append(summary,grid);
    ['decisionCount','commitmentCount','waitingCount'].forEach(id=>{const node=document.getElementById(id);if(node)new MutationObserver(syncActionSummary).observe(node,{childList:true,subtree:true,characterData:true})});
    syncActionSummary();
  }

  function syncConversationSummary(){
    const meta=document.getElementById('todayConversationMeta');
    if(meta)meta.textContent=`${countText('conversationCount')} today`;
  }

  function wrapConversations(){
    const lane=$('#actionableMemory .conversation-lane');
    if(!lane||document.getElementById('todayConversationCollapse'))return;
    const details=document.createElement('details');
    details.id='todayConversationCollapse';details.className='today-collapse today-conversation-collapse';
    const summary=document.createElement('summary');
    summary.innerHTML='<span class="today-collapse-title">Conversations</span><span id="todayConversationMeta" class="today-collapse-meta"></span><span class="today-collapse-chevron" aria-hidden="true">⌄</span>';
    lane.parentNode.insertBefore(details,lane);details.append(summary,lane);
    const count=document.getElementById('conversationCount');if(count)new MutationObserver(syncConversationSummary).observe(count,{childList:true,subtree:true,characterData:true});
    syncConversationSummary();
  }

  function clampBrief(){
    const brief=document.getElementById('dayBriefText');
    if(!brief||document.getElementById('dayBriefMore'))return;
    brief.classList.add('synap-clamped');
    const button=document.createElement('button');button.id='dayBriefMore';button.type='button';button.className='day-brief-more';button.textContent='More';button.setAttribute('aria-expanded','false');
    button.addEventListener('click',()=>{const expanded=brief.classList.toggle('synap-expanded');button.textContent=expanded?'Less':'More';button.setAttribute('aria-expanded',String(expanded))});
    brief.insertAdjacentElement('afterend',button);
  }

  function pipelineHasDetail(panel){return !!panel.querySelector('.today-memory-pipeline-current,.today-memory-track,.today-memory-pipeline-link')}
  function wirePipeline(){
    const panel=document.getElementById('todayMemoryPipeline');if(!panel)return;
    if(!panel.dataset.collapsed)panel.dataset.collapsed='true';
    const head=panel.querySelector('.today-memory-pipeline-head');if(!head||head.dataset.dashboardWired==='1')return;
    head.dataset.dashboardWired='1';head.setAttribute('role','button');head.tabIndex=0;
    const errors=panel.querySelectorAll('.today-memory-step[data-state="error"]').length;
    const count=head.querySelector('span');
    if(count&&errors&&!/attention/i.test(count.textContent||''))count.textContent=(count.textContent||'').trim()+` · ${errors} needs attention`;
    const arrow=document.createElement('span');arrow.className='today-memory-pipeline-toggle';arrow.setAttribute('aria-hidden','true');arrow.textContent='⌄';head.appendChild(arrow);
    const sync=()=>{const expanded=panel.dataset.collapsed!=='true';head.setAttribute('aria-expanded',String(expanded));arrow.style.visibility=pipelineHasDetail(panel)?'visible':'hidden'};
    const toggle=()=>{if(!pipelineHasDetail(panel))return;panel.dataset.collapsed=panel.dataset.collapsed==='true'?'false':'true';sync()};
    head.addEventListener('click',toggle);head.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle()}});sync();
  }

  function viewForHref(href){return href==='#insights'?'memories':href==='#ask'?'ask':href==='#library'?'library':'today'}
  function syncNav(view){
    $$('.brain-tabs a[href^="#"]').forEach(a=>{const active=viewForHref(a.getAttribute('href'))===view;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});
  }
  function setView(view,scroll=true){
    if(!VIEW_IDS[view])view='today';document.body.dataset.synapView=view;syncNav(view);
    if(scroll){const top=document.querySelector('.topbar')?.offsetHeight||0;window.scrollTo({top:Math.max(0,top-8),behavior:'auto'})}
  }
  function bindTabs(){
    const nav=$('.brain-tabs');if(!nav||nav.dataset.dashboardTabs==='1')return;nav.dataset.dashboardTabs='1';
    nav.addEventListener('click',e=>{const a=e.target.closest('a[href^="#"]');if(!a)return;e.preventDefault();e.stopImmediatePropagation();setView(viewForHref(a.getAttribute('href')));try{history.replaceState(history.state,'',location.pathname+location.search)}catch(_){}},true);
    addEventListener('hashchange',()=>{const view=viewForHref(location.hash);if(location.hash&&VIEW_IDS[view]){setView(view);setTimeout(()=>{try{history.replaceState(history.state,'',location.pathname+location.search)}catch(_){}},0)}});
    const initial=location.hash?viewForHref(location.hash):'today';setView(initial,false);
  }

  function scan(){wrapActions();wrapConversations();clampBrief();wirePipeline();bindTabs()}
  function init(){injectStyle();scan();let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;scan()})}).observe(document.body,{childList:true,subtree:true});}
  root.SynapDashboardUI={setView};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
