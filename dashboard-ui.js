/* Stable Synap shell: keep every core surface mounted and navigate by scroll. */
(function(root){
  'use strict';
  if(root.SynapDashboardUI&&root.SynapDashboardUI.__stableShell)return;

  const STYLE_ID='synapDashboardStyle';
  const VIEW_IDS={today:'#today',capture:'#capture',memories:'#insights',ask:'#ask',library:'#library'};
  const $=s=>document.querySelector(s);
  const $$=s=>[...document.querySelectorAll(s)];
  let observer=null;
  let observed=new Set();
  let navLockUntil=0;
  let activeView='today';

  function normalizeView(view){return VIEW_IDS[view]?view:'today'}
  function viewForHref(href){return href==='#capture'?'capture':href==='#insights'?'memories':href==='#ask'?'ask':href==='#library'?'library':'today'}
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
.section-card{transition:border-color .18s ease,box-shadow .18s ease}
.brain-tabs{isolation:isolate}
.brain-tabs:has(a[href="#capture"]):has(a[href="#ask"]){grid-template-columns:repeat(5,minmax(0,1fr))!important}
.brain-tabs a{touch-action:manipulation}
.brain-tabs a.active{font-weight:800}
`;
  }

  function ensureCaptureNav(){
    const nav=$('.brain-tabs');if(!nav||nav.querySelector('a[href="#capture"]'))return;
    const link=document.createElement('a');
    link.href='#capture';
    link.innerHTML='<svg aria-hidden="true"><use href="#i-mic"></use></svg><span>Capture</span>';
    const today=nav.querySelector('a[href="#today"]');
    if(today?.nextSibling)nav.insertBefore(link,today.nextSibling);else nav.prepend(link);
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
    root.SynapCompactLayout?.reveal(sectionFor(next));
    if(!scroll)return true;
    navLockUntil=Date.now()+900;
    const target=sectionFor(next);
    if(target){
      if(!target.hasAttribute('tabindex'))target.setAttribute('tabindex','-1');
      target.focus({preventScroll:true});
      const reduced=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({behavior:reduced?'auto':'smooth',block:'start'});
      return true;
    }
    setTimeout(()=>{const late=sectionFor(next);if(late)late.scrollIntoView({behavior:'auto',block:'start'})},80);
    return false;
  }

  function currentVisibleView(){
    // Today and Capture share the first desktop row; opening the app starts on
    // Today, while an explicit Capture selection remains authoritative there.
    if(window.scrollY<4)return activeView==='capture'?'capture':'today';
    const header=$('.topbar');
    const top=(header?.getBoundingClientRect().bottom||64)+18;
    // A desktop side rail does not obscure the bottom of the viewport.
    const nav=$('.brain-tabs')?.getBoundingClientRect();
    const bottom=nav&&nav.top>window.innerHeight/2?nav.top-12:window.innerHeight;
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

  function updateFromViewport(){if(Date.now()>=navLockUntil)syncNav(currentVisibleView())}

  function observeSections(){
    if(typeof IntersectionObserver==='undefined')return;
    if(!observer)observer=new IntersectionObserver(()=>updateFromViewport(),{root:null,rootMargin:'-18% 0px -55% 0px',threshold:[0,.1,.35,.7]});
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
    for(const id of ['todayActionsCollapse','todayConversationCollapse']){
      const details=document.getElementById(id);if(!details)continue;
      const parent=details.parentNode;if(!parent)continue;
      [...details.children].filter(node=>node.tagName!=='SUMMARY').forEach(node=>parent.insertBefore(node,details));
      details.remove();
    }
    const brief=document.getElementById('dayBriefText');
    brief?.classList.remove('synap-clamped','synap-expanded');
    document.getElementById('dayBriefMore')?.remove();
    const capture=document.getElementById('capture');
    if(capture){capture.classList.remove('capture-minimal');capture.classList.add('capture-product');capture.removeAttribute('aria-hidden')}
  }

  function bindDailyWorkspace(){
    const shortcuts=$('.day-shortcuts');
    if(shortcuts&&!shortcuts.dataset.bound){
      shortcuts.dataset.bound='1';
      shortcuts.addEventListener('click',event=>{
        const link=event.target.closest?.('[data-workspace-target]');
        if(!link||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
        const target=document.getElementById(link.dataset.workspaceTarget);
        if(!target)return;
        event.preventDefault();
        root.SynapCompactLayout?.reveal(target);
        syncNav(target.id==='synapWeeklyReview'?'today':'memories');
        navLockUntil=Date.now()+900;
        if(!target.hasAttribute('tabindex'))target.setAttribute('tabindex','-1');
        target.focus({preventScroll:true});
        target.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
      });
    }
    const tabs=$('.focus-tabs');
    if(!tabs||tabs.dataset.bound)return;
    tabs.dataset.bound='1';
    const buttons=[...tabs.querySelectorAll('[data-focus-tab]')];
    function select(button,focus=false){
      for(const item of buttons){
        const active=item===button;
        item.setAttribute('aria-selected',String(active));
        item.tabIndex=active?0:-1;
        const panel=document.getElementById(item.dataset.focusTab);
        if(panel)panel.hidden=!active;
      }
      if(focus)button.focus();
    }
    tabs.addEventListener('click',event=>{
      const button=event.target.closest?.('[data-focus-tab]');
      if(button)select(button);
    });
    tabs.addEventListener('keydown',event=>{
      const index=buttons.indexOf(event.target);
      if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:
        (index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
      select(buttons[next],true);
    });
  }

  function scan(){injectStyle();ensureCaptureNav();healLegacyWrappers();bindTabs();bindDailyWorkspace();observeSections();updateFromViewport()}
  function init(){
    scan();
    // Dynamic second-brain sections are inserted as direct children of <main>.
    // Observe only that boundary instead of the entire document: memory renders
    // can replace many descendant nodes without causing navigation rescans.
    const main=document.querySelector('main');
    if(main){
      const mutation=new MutationObserver(()=>requestAnimationFrame(()=>{ensureCaptureNav();observeSections();healLegacyWrappers()}));
      mutation.observe(main,{childList:true});
    }
    ['synap-cloud-history-updated','synap-memory-ready','synap-processing-state','synap-transcript-updated'].forEach(name=>addEventListener(name,()=>requestAnimationFrame(updateFromViewport)));
    if(location.hash&&VIEW_IDS[viewForHref(location.hash)])setTimeout(()=>setView(viewForHref(location.hash),true),0);
  }

  root.SynapDashboardUI=Object.freeze({__stableShell:true,setView,syncNav,observeSections});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
