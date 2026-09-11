/* Progressive disclosure without replacing recording, editing or source nodes. */
(function(root){
  'use strict';
  const KEY='synap-expanded-tiles-v1',tiles=new Map();
  const configs=[
    ['capture','.ambient-capture-head','Capture',false],
    ['insights','.section-heading','Memories',false],
    ['followupInbox','.section-heading','Follow-ups',false],
    ['peopleMemory','.section-heading','People',false],
    ['ask','.ask-head','Ask synap',false],
    ['library','.section-heading','Library',false],
    ['synapWeeklyReview','.synap-weekly-head','Weekly review',false],
    ['dailyFocus','.focus-heading','Next steps',false],
    ['dayConversations','header','Conversations',true]
  ];
  let preferences={};try{const saved=JSON.parse(localStorage.getItem(KEY)||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))preferences=saved}catch(_){}
  function persist(){try{localStorage.setItem(KEY,JSON.stringify(preferences))}catch(_){}}
  function setExpanded(tile,expanded,save=false){
    tile.body.hidden=!expanded;tile.section.classList.toggle('is-expanded',expanded);
    tile.button.setAttribute('aria-expanded',String(expanded));
    tile.button.setAttribute('aria-label',(expanded?'Collapse ':'Expand ')+tile.title);
    if(!expanded){if(tile.body.contains(document.activeElement))tile.button.focus({preventScroll:true});if(tile.section.id==='library')tile.body.querySelectorAll('audio').forEach(audio=>audio.pause())}
    if(save){preferences[tile.section.id]=expanded;persist()}
  }
  function register(section,heading,title,defaultOpen){
    if(!section||!heading||tiles.has(section.id))return;
    section.classList.add('workspace-tile');heading.classList.add('tile-heading');
    // Only decoration/repeated introductions are removed. Counts and controls keep their identities.
    heading.querySelectorAll('.section-eyebrow,.section-copy').forEach(node=>node.remove());
    const label=heading.querySelector('h2')||heading.querySelector('strong')||heading.querySelector('span');
    if(label){const text=[...label.childNodes].find(node=>node.nodeType===3);if(text)text.textContent=title+' '}
    const body=document.createElement('div');body.className='workspace-body';body.id=section.id+'Body';section.appendChild(body);
    const connect=heading.querySelector('#connectButton');if(connect)body.appendChild(connect);
    const button=document.createElement('button');button.type='button';button.className='tile-toggle';
    button.setAttribute('aria-controls',body.id);button.innerHTML='<svg aria-hidden="true"><use href="#i-chevron"/></svg>';heading.appendChild(button);
    const tile={section,heading,body,button,title};tiles.set(section.id,tile);
    const adopt=()=>{for(const child of[...section.childNodes])if(child!==heading&&child!==body)body.appendChild(child)};
    adopt();
    setExpanded(tile,typeof preferences[section.id]==='boolean'?preferences[section.id]:defaultOpen);
    button.addEventListener('click',()=>setExpanded(tile,body.hidden,true));
    heading.addEventListener('click',event=>{if(!event.target.closest('button,a,input,select,textarea,label,summary'))button.click()});
    // Late search fields/status controls are inserted beside the heading by existing modules.
    new MutationObserver(adopt).observe(section,{childList:true});
  }
  function scan(){for(const[id,selector,title,open]of configs){const section=document.getElementById(id);register(section,section?.querySelector(selector),title,open)}}
  function reveal(target){
    if(typeof target==='string')target=document.getElementById(target.replace(/^#/,''));
    if(!target)return;
    for(const tile of tiles.values())if(tile.section===target||tile.section.contains(target))setExpanded(tile,true);
  }
  function captureState(){
    if(document.body.dataset.state==='connecting'&&document.body.dataset.autoReconnecting==='true')return;
    if(['starting','recording','stopping','saving','updating','connecting'].includes(document.body.dataset.state))reveal('capture');
  }
  function init(){
    scan();
    const main=document.querySelector('main'),brief=document.querySelector('.day-brief');
    if(main)new MutationObserver(scan).observe(main,{childList:true});
    if(brief)new MutationObserver(scan).observe(brief,{childList:true});
    new MutationObserver(captureState).observe(document.body,{attributes:true,attributeFilter:['data-state']});
    captureState();
  }
  root.SynapCompactLayout=Object.freeze({reveal});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
