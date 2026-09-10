/* Apply before first paint; appearance and platform compatibility load before app.js. */
(function(){
  'use strict';

  if(typeof navigator!=='undefined'&&!navigator.locks){
    const fallback={async request(name,options,callback){if(typeof options==='function'){callback=options;options={};}return callback({name:String(name||''),mode:'exclusive'});}};
    try{Object.defineProperty(navigator,'locks',{value:fallback,configurable:true});}catch(_){try{navigator.locks=fallback}catch(__){}}
    document.documentElement.dataset.synapLockFallback='1';
  }

  if(typeof history!=='undefined'&&'scrollRestoration'in history)history.scrollRestoration='manual';
  try{
    if(typeof location!=='undefined'&&location.hash&&typeof history?.replaceState==='function'){
      history.replaceState(history.state,'',location.pathname+location.search);
    }
  }catch(_){}
  const key='synap-appearance';
  const SHELL_REVISION='1.0.0-dashboard2-ask';
  const root=document.documentElement;
  const valid=v=>['system','light','dark'].includes(v)?v:'system';
  let preference='system';
  try{preference=valid(localStorage.getItem(key))}catch(_){}

  function autoMode(){const hour=new Date().getHours();return hour>=7&&hour<19?'light':'dark'}
  function apply(){
    const mode=preference==='system'?autoMode():preference;
    root.dataset.theme=mode;root.setAttribute('data-theme',mode);root.style.colorScheme=mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',mode==='dark'?'#071426':'#f7f9fc');
    document.querySelectorAll('[data-theme-choice]').forEach(b=>{
      b.setAttribute('aria-pressed',String(b.dataset.themeChoice===preference));
      if(b.dataset.themeChoice==='system'){
        b.title='Auto: light 7 AM–7 PM, dark 7 PM–7 AM';
        b.setAttribute('aria-label','Auto appearance — light 7 AM to 7 PM, dark 7 PM to 7 AM');
      }
    });
  }
  function choose(value){preference=valid(value);try{localStorage.setItem(key,preference)}catch(_){}apply()}
  function refreshAuto(){if(preference==='system')apply()}
  function css(href,k,v){
    if(document.querySelector(`link[data-synap-${k}]`))return;
    const l=document.createElement('link');l.rel='stylesheet';l.href=href;
    l.dataset['synap'+k[0].toUpperCase()+k.slice(1)]=v;document.head.appendChild(l);
  }
  function script(src){
    const target=String(src||'').split('?')[0].replace(/^\.\//,'');
    const exists=[...document.querySelectorAll('script[src]')].some(s=>{
      const raw=String(s.getAttribute('src')||'');
      if(!raw)return false;
      return raw.split('?')[0].replace(/^\.\//,'')===target;
    });
    if(exists)return;
    const s=document.createElement('script');s.src=src;s.defer=true;document.head.appendChild(s);
  }
  function $(id){return typeof document.getElementById==='function'?document.getElementById(id):null}
  function installAISettings(){
    if(typeof document.getElementById!=='function')return;
    const fields=document.querySelector('.processing-fields'),endpoint=$('endpointInput'),llm=$('llmEndpointInput'),token=$('tokenInput');
    if(!fields||!endpoint||!llm||!token||$('providerInput'))return;
    const p=document.createElement('label');p.className='field';
    p.innerHTML='<span>AI provider</span><select id="providerInput"><option value="openai">OpenAI</option><option value="custom">Custom / other provider</option></select><small>OpenAI needs only an API key. Custom mode keeps endpoint support.</small>';
    const models=document.createElement('div');models.id='openAIModelFields';models.className='processing-fields';
    models.innerHTML='<label class="field"><span>Transcription model</span><select id="sttModelInput"><option value="gpt-4o-mini-transcribe">GPT-4o mini Transcribe</option><option value="gpt-4o-transcribe">GPT-4o Transcribe</option><option value="gpt-4o-transcribe-diarize">GPT-4o Transcribe Diarize</option></select></label><label class="field"><span>Memory model</span><select id="llmModelInput"><option value="gpt-5-mini">GPT-5 mini</option><option value="gpt-5">GPT-5</option><option value="gpt-4.1-mini">GPT-4.1 mini</option></select><small>Builds conversations, people, decisions, commitments and follow-ups.</small></label><label class="field"><span>Transcription language</span><select id="languageInput"><option value="auto">Auto detect</option><option value="en">English</option><option value="hi">Hindi / Hinglish</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="ja">Japanese</option></select></label>';
    const custom=document.createElement('div');custom.id='customEndpointFields';custom.className='processing-fields';custom.append(endpoint.closest('label'),llm.closest('label'));
    const tl=token.closest('label')?.querySelector('span');if(tl){tl.id='apiKeyLabel';tl.textContent='OpenAI API key'}
    token.placeholder='sk-…';token.autocomplete='off';fields.prepend(p,models,custom);
    script('ai-providers.js?v=0.0.1-brain3');script('sleep-state-guard.js?v=1.0.0-power1');script('recording-bridge.js?v=1.0.0-touch5');
  }
  function bind(){
    document.querySelectorAll('[data-theme-choice]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();choose(b.dataset.themeChoice)}));
    document.addEventListener('click',e=>{const b=e.target.closest?.('[data-theme-choice]');if(b){e.preventDefault();choose(b.dataset.themeChoice)}});
    installAISettings();
    css('settings-icon-fix.css?v=1.0.0-logo3','settingsicon','logo3');
    script('capture-ui.js?v=1.0.0-ui6');
    script('brain-ui.js?v=0.0.1-brain7');
    script('ask-synap.js?v=1.0.0-ask1');
    script('product-ui.js?v=1.0.0-ui4');
    script('runtime-ui.js?v=1.0.0-runtime3');
    script('dashboard-ui.js?v=1.0.0-dashboard1');
    script('productivity-tools.js?v=1.0.0-productivity3');
    script('desktop-capture.js?v=1.0.0-desktop3');
    script('interaction-surfaces.js?v=1.0.0-interactions2');
    script('memory-ready-events.js?v=1.0.0-memory-events1');
    script('experience-recovery.js?v=1.0.0-source-recovery1');
    apply();
  }
  css('brand.css?v=1.0.0-brain1','brand','brain1');
  css('compact.css?v=0.0.1-ui3','compact','ui3');
  css('brain.css?v=0.0.1-brain10','brain','brain10');
  window.addEventListener('storage',e=>{if(e.key===key||e.key===null){preference=valid(e.newValue);apply()}});
  window.addEventListener('focus',refreshAuto);window.addEventListener('pageshow',refreshAuto);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshAuto()});
  if(typeof setInterval==='function')setInterval(refreshAuto,60000);
  apply();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
})();