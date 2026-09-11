/* Keep action surfaces mounted while switching their visible panel. */
(function(root){
  'use strict';
  const panels=[['ask','Ask Synap'],['dailyFocus','Next steps'],['followupInbox','Follow-ups'],['peopleMemory','People']];
  let selected='ask',section,tablist,content;
  const scrollPositions=new Map();

  function select(id,{focus=false}={}){
    if(!section||!panels.some(([key])=>key===id))return false;
    const changed=selected!==id;
    if(changed)scrollPositions.set(selected,content.scrollTop);
    selected=id;
    for(const [key] of panels){
      const active=key===id,tab=document.getElementById('actionsTab-'+key),panel=document.getElementById(key);
      tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
      if(panel)panel.hidden=!active;
    }
    if(changed)content.scrollTop=scrollPositions.get(id)||0;
    if(focus)document.getElementById('actionsTab-'+id).focus({preventScroll:true});
    return true;
  }

  function reveal(target){
    if(typeof target==='string')target=document.getElementById(target.replace(/^#/,''));
    const panel=target?.closest('[data-actions-panel]');
    if(panel&&section?.contains(panel))select(panel.id);
  }

  function updateDay(){
    const value=document.getElementById('datePicker')?.value;
    const date=value?new Date(value+'T12:00:00'):new Date();
    const label=document.getElementById('actionsDay');
    if(label&&!Number.isNaN(date.getTime()))label.textContent=date.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'});
  }

  function mount(){
    const main=document.querySelector('main');
    if(!main||panels.some(([id])=>!document.getElementById(id)))return;
    if(!section){
      section=document.createElement('section');section.id='myActions';section.className='section-card my-actions';
      section.setAttribute('aria-labelledby','myActionsTitle');
      section.innerHTML='<div class="section-heading"><h2 id="myActionsTitle">My actions</h2></div><div class="actions-tabs" role="tablist" aria-label="My actions"></div><div id="myActionsContent" class="actions-content"></div>';
      tablist=section.querySelector('.actions-tabs');
      content=section.querySelector('.actions-content');
      for(const [id,label] of panels){
        const tab=document.createElement('button');tab.type='button';tab.id='actionsTab-'+id;
        tab.setAttribute('role','tab');tab.setAttribute('aria-controls',id);tab.textContent=label;
        tablist.appendChild(tab);
      }
      main.insertBefore(section,document.getElementById('library'));
      tablist.addEventListener('click',event=>{
        const tab=event.target.closest('[role="tab"]');if(tab)select(tab.getAttribute('aria-controls'));
      });
      tablist.addEventListener('keydown',event=>{
        const tabs=[...tablist.children],index=tabs.indexOf(event.target);
        if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();
        const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
        select(tabs[next].getAttribute('aria-controls'),{focus:true});
      });
      document.getElementById('datePicker')?.addEventListener('change',updateDay);
    }
    for(const [id] of panels){
      const panel=document.getElementById(id);
      if(content.contains(panel))continue;
      panel.dataset.actionsPanel='';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','actionsTab-'+id);panel.tabIndex=0;
      panel.classList.remove('section-card');
      content.appendChild(panel);
    }
    const focus=document.getElementById('dailyFocus');
    if(!document.getElementById('actionsDay')){
      const label=document.createElement('p');label.id='actionsDay';label.className='actions-day';focus.prepend(label);
    }
    updateDay();select(selected);
  }

  function init(){
    mount();
    const main=document.querySelector('main');
    if(main)new MutationObserver(mount).observe(main,{childList:true});
  }
  root.SynapMyActions=Object.freeze({select,reveal});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
