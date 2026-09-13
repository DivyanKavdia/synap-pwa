/* Apply before first paint; appearance and platform compatibility load before app.js. */
(function(){
  'use strict';

  if(typeof history!=='undefined'&&'scrollRestoration'in history)history.scrollRestoration='manual';

  const key='synap-appearance';
  const paletteKey='synap-palette';
  const paletteBackgrounds={olive:{light:'#f4f7f5',dark:'#101b17'},blue:{light:'#f3f6fb',dark:'#111a29'},pink:{light:'#fcf5f8',dark:'#24151e'},lavender:{light:'#f7f5fc',dark:'#1c1829'}};
  const root=document.documentElement;
  const valid=v=>['system','light','dark'].includes(v)?v:'system';
  const validPalette=v=>Object.prototype.hasOwnProperty.call(paletteBackgrounds,v)?v:'olive';
  let preference='system';
  let palette='olive';
  try{preference=valid(localStorage.getItem(key))}catch(_){}
  try{palette=validPalette(localStorage.getItem(paletteKey))}catch(_){}
  function logoSource(){const mode=root.dataset.theme==='dark'?'dark':'light';return 'synap-logo-'+(palette==='olive'?'':palette+'-')+mode+'.png?v=1.0.0-ui-fix1'}

  function autoMode(){const hour=new Date().getHours();return hour>=7&&hour<19?'light':'dark'}
  function apply(){
    const mode=preference==='system'?autoMode():preference;
    root.dataset.theme=mode;root.setAttribute('data-theme',mode);root.style.colorScheme=mode;
    root.dataset.palette=palette;
    document.querySelectorAll('.synap-brand-image').forEach(img=>{
      const source=logoSource();
      if(img.getAttribute('src')!==source)img.setAttribute('src',source);
    });
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',paletteBackgrounds[palette][mode]);
    document.querySelectorAll('[data-palette-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.paletteChoice===palette)));
    document.querySelectorAll('[data-theme-choice]').forEach(b=>{
      b.setAttribute('aria-pressed',String(b.dataset.themeChoice===preference));
      if(b.dataset.themeChoice==='system'){
        b.title='Auto: light 7 AM–7 PM, dark 7 PM–7 AM';
        b.setAttribute('aria-label','Auto appearance — light 7 AM to 7 PM, dark 7 PM to 7 AM');
      }
    });
  }
  function choose(value){preference=valid(value);try{localStorage.setItem(key,preference)}catch(_){}apply()}
  function choosePalette(value){palette=validPalette(value);try{localStorage.setItem(paletteKey,palette)}catch(_){}apply()}
  function refreshAuto(){if(preference==='system')apply()}

  function bind(){
    document.querySelectorAll('[data-theme-choice]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();choose(b.dataset.themeChoice)}));
    document.querySelectorAll('[data-palette-choice]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();choosePalette(b.dataset.paletteChoice)}));
    apply();
  }

  window.addEventListener('storage',e=>{if(e.key===key)preference=valid(e.newValue);else if(e.key===paletteKey)palette=validPalette(e.newValue);else if(e.key===null){preference='system';palette='olive'}else return;apply()});
  window.SynapAppearance=Object.freeze({logoSource,choosePalette});
  window.addEventListener('focus',refreshAuto);window.addEventListener('pageshow',refreshAuto);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshAuto()});
  if(typeof setInterval==='function')setInterval(refreshAuto,60000);
  apply();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
})();
