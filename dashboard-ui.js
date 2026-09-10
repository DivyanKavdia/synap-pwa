/* Stable Synap shell: keep every core surface mounted and navigate by scroll. */
(function(root){
  'use strict';
  if(root.SynapDashboardUI&&root.SynapDashboardUI.__stableShell)return;

  const STYLE_ID='synapDashboardStyle';
  const VIEW_IDS={today:'#today',memories:'#insights',ask:'#ask',library:'#library'};
  const $=s=>document.querySelector(s);
  const $$=s=>[...document.querySelectorAll(s)];
  let observer=null;
  let observed=new Set();
  let navLockUntil=0;
  let activeView='today';

  function normalizeView(view){return VIEW_IDS[view]?view:'today'}
  function viewForHref(href){return href==='#insights'?'memories':href==='#ask'?'ask':href==='#library'?'library':'today'}
  function sectionFor(view){return document.querySelector(VIEW_IDS[normalizeView(view)])}

  function injectStyle(){
    let style=document.getElementById(STYLE_ID);
    if(!style){style=document.createElement('style');style.id=STYLE_ID;document.head.appendChild(style)}
    style.textContent=`
html,body{max-width:100%;overflow-x:clip}
main{display:block!important}
body[data-synap-view] #today,
body[data-synap-view] #insights,
body[data-synap-view] #followupInbox,
body[data-synap-view] #peopleMemory,
body[data-synap-view] #ask,
body[data-synap-view] #capture,
body[data-synap-view] #library{display:block!important;visibility:visible!important;opacity:1!important}
#today,#insights,#followupInbox,#peopleMemory,#ask,#capture,#library{scroll-margin-top:84px;content-visibility:visible!important}
.app-shell,main,.brain-home,.day-brief,.actionable-memory,.action-grid,.conversation-lane,.section-card{min-width:0;max-width:100%}
.brain-tabs{isolation:isolate}
.brain-tabs a{touch-action:manipulation}
.brain-tabs a.active{font-weight:800}
@media(min-width:760px){.app-shell{max-width:980px}.brain-home,#insights,#followupInbox,#peopleMemory,#ask,#capture,#library{max-width:860px;margin-left:auto!important;margin-right:auto!important}}
`;
  }

  function syncNav(view){
    activeView=normalizeView(view);
    document.body.dataset.synapView=activeView;
    $$('.brain-tabs a[href^="#"]').forEach(a=>{
      const active=viewForHref(a.getAttribute('href'))===activeView;
      a.classList.toggle('active',active);
      if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
    });
  }

  function setView(view,scroll=true){
    const next=normalizeView(view);
    syncNav(next);
    if(!scroll)return true;
    navLockUntil=Date.now()+900;
    const target=sectionFor(next);
    if(target){
      const reduced=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({behavior:reduced?'auto':'smooth',block:'start'});
      return true;
    }
    // Brain/Ask sections can be inserted a few milliseconds after DOMContentLoaded.
    setTimeout(()=>{const late=sectionFor(next);if(late)late.scrollIntoView({behavior:'auto',block:'start'})},80);
    return false;
  }

  function currentVisibleView(){
    const header=$('.topbar');
    const top=(header?.getBoundingClientRect().bottom||64)+18;
    const bottom=window.innerHeight-Math.max(78,$('.brain-tabs')?.offsetHeight||0);
    let best={view:'today',score:-1};
    for(const [view,selector] of Object.entries(VIEW_IDS)){
      const node=$(selector);if(!node)continue;
      const rect=node.getBoundingClientRect();
      const visible=Math.max(0,Math.min(rect.bottom,bottom)-Math.max(rect.top,top));
      const centerPenalty=Math.abs(((rect.top+rect.bottom)/2)-((top+bottom)/2))/Math.max(1,window.innerHeight);
      const score=visible-centerPenalty*20;
      if(score>best.score)best={view,score};
    }
    return best.view;
  }

  function updateFromViewport(){
    if(Date.now()<navLockUntil)return;
    syncNav(currentVisibleView());
  }

  function observeSections(){
    if(typeof IntersectionObserver==='undefined')return;
    if(!observer){
      observer=new IntersectionObserver(()=>updateFromViewport(),{root:null,rootMargin:'-18% 0px -55% 0px',threshold:[0,.1,.35,.7]});
    }
    for(const selector of Object.values(VIEW_IDS)){
      const node=$(selector);if(node&&!observed.has(node)){observed.add(node);observer.observe(node)}
    }
  }

  function bindTabs(){
    const nav=$('.brain-tabs');if(!nav||nav.dataset.stableShell==='1')return;
    nav.dataset.stableShell='1';
    nav.addEventListener('click',event=>{
      const link=event.target.closest?.('a[href^="#"]');if(!link)return;
      event.preventDefault();
      setView(viewForHref(link.getAttribute('href')),true);
      try{history.replaceState(history.state,'',location.pathname+location.search)}catch(_){}
    });
    addEventListener('scroll',()=>requestAnimationFrame(updateFromViewport),{passive:true});
    addEventListener('resize',()=>requestAnimationFrame(updateFromViewport),{passive:true});
    addEventListener('hashchange',()=>{if(location.hash){setView(viewForHref(location.hash),true);try{history.replaceState(history.state,'',location.pathname+location.search)}catch(_){}}});
  }

  function healLegacyWrappers(){
    // Old dashboard revisions moved live memory areas into collapsible <details>.
    // If a hot-updated page still contains them, unwrap once without replacing
    // any child nodes or handlers.
    for(const id of ['todayActionsCollapse','todayConversationCollapse']){
      const details=document.getElementById(id);if(!details)continue;
      const parent=details.parentNode;if(!parent)continue;
      [...details.children].filter(node=>node.tagName!=='SUMMARY').forEach(node=>parent.insertBefore(node,details));
      details.remove();
    }
    const brief=document.getElementById('dayBriefText');
    brief?.classList.remove('synap-clamped','synap-expanded');
    document.getElementById('dayBriefMore')?.remove();
  }

  function scan(){injectStyle();healLegacyWrappers();bindTabs();observeSections();updateFromViewport()}
  function init(){
    scan();
    const mutation=new MutationObserver(()=>requestAnimationFrame(()=>{observeSections();healLegacyWrappers()}));
    mutation.observe(document.body,{childList:true,subtree:true});
    ['synap-cloud-history-updated','synap-memory-ready','synap-processing-state','synap-transcript-updated'].forEach(name=>addEventListener(name,()=>requestAnimationFrame(updateFromViewport)));
    if(location.hash&&VIEW_IDS[viewForHref(location.hash)])setTimeout(()=>setView(viewForHref(location.hash),true),0);
  }

  root.SynapDashboardUI=Object.freeze({__stableShell:true,setView,syncNav,observeSections});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
