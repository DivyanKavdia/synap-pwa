/* Settings shares the live header and navigation with the rest of the app. */
(function(root){
  'use strict';
  let dialog,header,main,nav,backdrop,headerSpacer,previousFocus,previousInert=false,scrollPosition=0;
  let active=false,frame=0,bodyOverflow='',htmlOverflow='';
  function layout(){
    frame=0;if(!active)return;
    const bounds=main.getBoundingClientRect(),navigation=nav?.getBoundingClientRect();
    const viewport=root.visualViewport;
    const keyboardInset=viewport?Math.max(0,root.innerHeight-viewport.height-viewport.offsetTop):0;
    const bottom=Math.max(keyboardInset,navigation&&navigation.top>root.innerHeight/2?root.innerHeight-navigation.top+8:12);
    const style=document.documentElement.style;
    style.setProperty('--settings-header-left',bounds.left+'px');
    style.setProperty('--settings-header-width',bounds.width+'px');
    style.setProperty('--settings-header-top',(viewport?.offsetTop||0)+'px');
    style.setProperty('--settings-top',Math.max(0,header.getBoundingClientRect().bottom)+'px');
    style.setProperty('--settings-bottom',bottom+'px');
    style.setProperty('--settings-left',bounds.left+'px');
    style.setProperty('--settings-right',Math.max(0,document.documentElement.getBoundingClientRect().right-bounds.right)+'px');
  }
  function schedule(){if(active&&!frame)frame=requestAnimationFrame(layout)}
  function sync(){
    if(dialog.open===active)return;
    active=dialog.open;
    const button=document.getElementById('settingsButton');
    button?.setAttribute('aria-expanded',String(active));
    button?.setAttribute('aria-label',active?'Close settings':'Open settings');
    backdrop.hidden=!active;
    if(active){
      const bounds=header.getBoundingClientRect(),style=document.documentElement.style;
      style.setProperty('--settings-header-left',bounds.left+'px');
      style.setProperty('--settings-header-width',bounds.width+'px');
      headerSpacer.style.height=bounds.height+'px';headerSpacer.hidden=false;
      document.body.classList.add('settings-open');
      previousInert=main.inert;main.inert=true;
      bodyOverflow=document.body.style.overflow;htmlOverflow=document.documentElement.style.overflow;
      document.body.style.overflow='hidden';document.documentElement.style.overflow='hidden';
      layout();
    }else{
      document.body.classList.remove('settings-open');headerSpacer.hidden=true;
      main.inert=previousInert;
      document.body.style.overflow=bodyOverflow;document.documentElement.style.overflow=htmlOverflow;
      root.scrollTo({top:scrollPosition,behavior:'instant'});
      if(previousFocus?.isConnected&&!previousFocus.closest('[inert]'))previousFocus.focus({preventScroll:true});
    }
  }
  function init(){
    if(dialog)return true;
    dialog=document.getElementById('settingsDialog');header=document.querySelector('.topbar');
    main=document.querySelector('main');nav=document.querySelector('.brain-tabs');
    if(!dialog||!header||!main){dialog=null;return false;}
    dialog.classList.add('settings-panel');
    dialog.setAttribute('aria-modal','false');
    document.getElementById('settingsButton')?.setAttribute('aria-controls',dialog.id);
    document.getElementById('settingsButton')?.setAttribute('aria-expanded','false');
    backdrop=document.createElement('div');backdrop.className='settings-backdrop';backdrop.hidden=true;
    backdrop.setAttribute('aria-hidden','true');dialog.before(backdrop);
    headerSpacer=document.createElement('div');headerSpacer.hidden=true;headerSpacer.setAttribute('aria-hidden','true');header.after(headerSpacer);
    dialog.addEventListener('close',sync);
    new MutationObserver(sync).observe(dialog,{attributes:true,attributeFilter:['open']});
    document.addEventListener('keydown',event=>{
      if(active&&event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('dialog:modal')){event.preventDefault();close();}
    });
    document.addEventListener('click',event=>{
      if(active&&event.target.closest?.('.brain-tabs a,.topbar .brand,.skip-link'))close();
    },true);
    root.addEventListener('resize',schedule);
    root.visualViewport?.addEventListener('resize',schedule);
    root.visualViewport?.addEventListener('scroll',schedule);
    if(root.ResizeObserver)new ResizeObserver(schedule).observe(header);
    return true;
  }
  function open(){
    if(!init()||dialog.open)return;
    previousFocus=document.activeElement;scrollPosition=root.scrollY;
    dialog.show();sync();dialog.scrollTop=0;
    document.getElementById('closeSettingsButton')?.focus({preventScroll:true});
  }
  function close(){if(!dialog?.open)return;dialog.close();sync();}
  function toggle(){if(!init())return;dialog.open?close():open();}
  root.SynapSettingsPanel=Object.freeze({open,close,toggle});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
