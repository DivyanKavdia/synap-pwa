/* Reliable one-tap PWA Remember This handler. Hardware Remember This remains a long press on TTP223. */
(function(root){
'use strict';

const HKEY='synap-memory-highlights',DB='dk-pendant-recordings',TODAY_PIPELINE_ID='todayMemoryPipeline',STYLE_ID='synap-today-pipeline-style';
let pipelineRefreshTimer=0;

function read(){try{return JSON.parse(localStorage.getItem(HKEY)||'[]')}catch(_){return[]}}
function write(v){try{localStorage.setItem(HKEY,JSON.stringify(v.slice(-500)))}catch(_){}}
function timerSeconds(){const t=document.getElementById('timer')?.textContent||'';const p=t.split(':').map(Number);if(p.some(Number.isNaN))return null;return p.length===2?p[0]*60+p[1]:p.length===3?p[0]*3600+p[1]*60+p[2]:null}
function latest(){return new Promise(resolve=>{try{const q=indexedDB.open(DB);q.onerror=()=>resolve(null);q.onsuccess=()=>{const db=q.result;try{const r=db.transaction('recordings').objectStore('recordings').getAll();r.onerror=()=>{db.close();resolve(null)};r.onsuccess=()=>{const list=(r.result||[]).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));db.close();resolve(list.find(x=>x.status==='recording'||x.state==='recording')||list[0]||null)}}catch(_){db.close();resolve(null)}}}catch(_){resolve(null)}})}
async function mark(button){const state=document.body.dataset.state||'',active=['recording','starting'].includes(state),rec=await latest(),hs=read(),now=Date.now();const h={id:root.crypto?.randomUUID?.()||String(now),createdAt:new Date(now).toISOString(),recordingId:rec?.id||null,offsetSeconds:active?timerSeconds():null,source:active?'live-capture':'manual'};hs.push(h);write(hs);if(button){const old=button.textContent;button.textContent='✓ Remembered';button.classList.add('remembered');button.disabled=true;setTimeout(()=>{button.textContent=old;button.classList.remove('remembered');button.disabled=false},1200)}root.dispatchEvent(new CustomEvent('synap-memory-highlight',{detail:h}))}
document.addEventListener('click',e=>{const b=e.target?.closest?.('#rememberThis');if(!b)return;e.preventDefault();e.stopImmediatePropagation();mark(b)},{capture:true});

/* Keep transient firmware discovery errors out of the primary Today surface.
   The detailed result remains visible in Settings > Firmware / Diagnostics. */
function guardFirmwareNotice(){
  const notice=document.getElementById('firmwareNotice'),text=document.getElementById('firmwareNoticeText');
  if(!notice||!text)return;
  const apply=()=>{if(/^Update check:/i.test(String(text.textContent||'').trim()))notice.hidden=true;};
  apply();
  if(root.MutationObserver)new MutationObserver(apply).observe(text,{childList:true,subtree:true,characterData:true});
}

function localDay(value){const d=new Date(value);if(Number.isNaN(d.getTime()))return'';return[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
function requestAll(store){return new Promise((resolve,reject)=>{const r=store.getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)})}
function pipelineSnapshot(){return new Promise(resolve=>{try{const q=indexedDB.open(DB);q.onerror=()=>resolve({recordings:[],jobs:[]});q.onsuccess=async()=>{const db=q.result;try{if(!db.objectStoreNames.contains('recordings')){db.close();resolve({recordings:[],jobs:[]});return}const names=['recordings'];if(db.objectStoreNames.contains('jobs'))names.push('jobs');const tx=db.transaction(names,'readonly'),recordings=await requestAll(tx.objectStore('recordings')),jobs=names.includes('jobs')?await requestAll(tx.objectStore('jobs')):[];db.close();resolve({recordings,jobs})}catch(_){try{db.close()}catch(__){}resolve({recordings:[],jobs:[]})}}}catch(_){resolve({recordings:[],jobs:[]})}})}
function injectTodayPipelineStyles(){if(document.getElementById(STYLE_ID))return;const style=document.createElement('style');style.id=STYLE_ID;style.textContent='.today-memory-pipeline{margin:14px 0 16px;padding:12px;border:1px solid rgba(255,255,255,.13);border-radius:14px;background:rgba(255,255,255,.07);color:#fff}.today-memory-pipeline-head,.today-memory-pipeline-current{display:flex;align-items:center;justify-content:space-between;gap:10px}.today-memory-pipeline-head strong{font-size:10px;letter-spacing:.03em}.today-memory-pipeline-head span,.today-memory-pipeline-current span{font-size:8px;color:#b9c8d9}.today-memory-pipeline-current{margin-top:9px}.today-memory-pipeline-current strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;font-weight:650}.today-memory-track{display:grid;grid-template-columns:repeat(var(--today-pipeline-steps),minmax(0,1fr));margin-top:11px}.today-memory-step{position:relative;min-width:0;text-align:center;color:#91a3b7}.today-memory-step::before{content:"";position:absolute;top:5px;right:50%;width:100%;height:2px;background:rgba(255,255,255,.16)}.today-memory-step:first-child::before{display:none}.today-memory-dot{position:relative;z-index:1;display:block;width:10px;height:10px;margin:0 auto 5px;border:2px solid currentColor;border-radius:50%;background:#102744}.today-memory-step small{display:block;padding:0 1px;font-size:6.5px;line-height:1.2}.today-memory-step[data-state="done"]{color:#42d9a7}.today-memory-step[data-state="done"]::before{background:#42d9a7}.today-memory-step[data-state="done"] .today-memory-dot{background:#42d9a7}.today-memory-step[data-state="active"]{color:#78baff;font-weight:750}.today-memory-step[data-state="active"] .today-memory-dot{box-shadow:0 0 0 3px rgba(120,186,255,.15)}.today-memory-step[data-state="error"]{color:#ff8b98}.today-memory-step[data-state="error"] .today-memory-dot{background:#ff8b98}.today-memory-pipeline-link{display:inline-flex;margin-top:10px;padding:0;border:0;background:none;color:#78baff;font:inherit;font-size:8px;font-weight:720;cursor:pointer}@media(min-width:600px){.today-memory-pipeline-head strong{font-size:12px}.today-memory-pipeline-head span,.today-memory-pipeline-current span,.today-memory-pipeline-link{font-size:10px}.today-memory-pipeline-current strong{font-size:11px}.today-memory-step small{font-size:8px}}';document.head.appendChild(style)}
function jobsByRecording(jobs){const map=new Map();(jobs||[]).forEach(job=>{const id=String(job.recordingId||'');if(!map.has(id))map.set(id,[]);map.get(id).push(job)});return map}
function chooseFocus(items){return items.find(x=>x.model.tone==='active')||items.find(x=>x.model.tone==='error')||items.find(x=>x.model.tone==='waiting')||items[0]}
function openLibrary(){const link=document.querySelector('.brain-tabs a[href="#library"]');if(link&&typeof link.click==='function')link.click();else location.hash='#library'}
function setText(node,value){value=String(value??'');if(node&&node.textContent!==value)node.textContent=value}

function ensureTodayPipeline(brief){
  let panel=document.getElementById(TODAY_PIPELINE_ID);
  if(panel)return panel;
  injectTodayPipelineStyles();
  panel=document.createElement('section');
  panel.id=TODAY_PIPELINE_ID;
  panel.className='today-memory-pipeline';
  panel.setAttribute('aria-label','Memory processing status');

  const head=document.createElement('div');
  head.className='today-memory-pipeline-head';
  const title=document.createElement('strong');
  title.textContent='MEMORY PROCESSING';
  const count=document.createElement('span');
  count.className='today-memory-pipeline-count';
  head.append(title,count);

  const current=document.createElement('div');
  current.className='today-memory-pipeline-current';
  const name=document.createElement('strong');
  name.className='today-memory-pipeline-name';
  const status=document.createElement('span');
  status.className='today-memory-pipeline-status';
  current.append(name,status);

  const track=document.createElement('div');
  track.className='today-memory-track';

  const button=document.createElement('button');
  button.type='button';
  button.className='today-memory-pipeline-link';
  button.addEventListener('click',openLibrary);

  panel.append(head,current,track,button);
  brief.insertAdjacentElement('afterend',panel);
  return panel;
}

function updatePipelineSteps(track,steps){
  const existing=[...track.querySelectorAll('.today-memory-step')];
  if(existing.length!==steps.length){
    const fragment=document.createDocumentFragment();
    steps.forEach(item=>{
      const step=document.createElement('div');
      step.className='today-memory-step';
      const dot=document.createElement('span');
      dot.className='today-memory-dot';
      dot.setAttribute('aria-hidden','true');
      const label=document.createElement('small');
      step.append(dot,label);
      fragment.appendChild(step);
    });
    track.replaceChildren(fragment);
  }
  track.style.setProperty('--today-pipeline-steps',String(steps.length));
  const nodes=[...track.querySelectorAll('.today-memory-step')];
  steps.forEach((item,index)=>{
    const step=nodes[index];if(!step)return;
    if(step.dataset.state!==String(item.state||''))step.dataset.state=String(item.state||'');
    setText(step.querySelector('small'),item.label||'');
  });
}

async function renderTodayPipeline(){
  const api=root.SynapProcessingPipeline,brief=document.getElementById('dayBriefText');if(!api||typeof api.derive!=='function'||!brief)return;
  const data=await pipelineSnapshot(),selected=document.getElementById('datePicker')?.value||localDay(new Date()),map=jobsByRecording(data.jobs),recordings=(data.recordings||[]).filter(r=>localDay(r.createdAt)===selected).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  let panel=document.getElementById(TODAY_PIPELINE_ID);if(!recordings.length){panel?.remove();return}
  const items=recordings.map(recording=>({recording,model:api.derive(recording,map.get(String(recording.id))||[])})),ready=items.filter(x=>x.model.tone==='ready').length,focus=chooseFocus(items);if(!focus)return;
  panel=ensureTodayPipeline(brief);
  const count=panel.querySelector('.today-memory-pipeline-count');
  const name=panel.querySelector('.today-memory-pipeline-name');
  const status=panel.querySelector('.today-memory-pipeline-status');
  const track=panel.querySelector('.today-memory-track');
  const button=panel.querySelector('.today-memory-pipeline-link');
  setText(count,ready+' of '+items.length+' ready');
  setText(name,focus.recording.name||'Latest recording');
  setText(status,focus.model.status||'');
  if(track){focus.model.steps.forEach(()=>{});updatePipelineSteps(track,focus.model.steps||[])}
  setText(button,items.length>1?'View all recording pipelines →':'View recording pipeline →');
}

function scheduleTodayPipeline(delay=80){
  clearTimeout(pipelineRefreshTimer);
  pipelineRefreshTimer=setTimeout(()=>renderTodayPipeline().catch(()=>{}),delay);
}

function bindTodayPipeline(){
  guardFirmwareNotice();
  document.getElementById('datePicker')?.addEventListener('change',()=>scheduleTodayPipeline(40));
  const queue=document.getElementById('queueStatus');
  if(queue&&root.MutationObserver)new MutationObserver(()=>scheduleTodayPipeline(40)).observe(queue,{childList:true,subtree:true,characterData:true});
  if(root.SynapAuth&&typeof root.SynapAuth.onChange==='function')root.SynapAuth.onChange(()=>scheduleTodayPipeline(40));
  ['synap-processing-state','synap-memory-ready','synap-cloud-history-updated','synap-transcript-updated'].forEach(name=>root.addEventListener?.(name,()=>scheduleTodayPipeline(40)));
  scheduleTodayPipeline(600);
}

root.SynapTodayPipeline={refresh:()=>renderTodayPipeline()};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindTodayPipeline,{once:true});else bindTodayPipeline();
})(globalThis);
