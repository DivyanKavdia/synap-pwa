/* Rich meeting detail stays inside existing recording and People sections. */
(function(root){
  'use strict';
  const signatures=new WeakMap();
  const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=value;return node};
  const clock=ms=>{const s=Math.floor(Math.max(0,Number(ms)||0)/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
  function sourceButton(id,ms,label){const b=text('button',label+' · '+clock(ms));b.type='button';b.className='source-jump meeting-source';b.dataset.id=id;b.dataset.offsetMs=String(ms||0);return b}
  function group(host,title,items,id){
    if(!items.length)return;
    const section=document.createElement('section');section.append(text('h4',title));
    const list=document.createElement('ul');
    for(const item of items){const li=document.createElement('li');li.append(sourceButton(item.source?.recording_id||id,item.source?.start_ms??item.start_ms,item.text||item.task||item.title));
      const meta=[item.kind==='reminder'?'Suggested reminder':null,item.owner==='self'?'You':item.owner,item.due_date].filter(Boolean).join(' · ');
      if(meta)li.append(text('small',meta));if(item.summary)li.append(text('p',item.summary));list.append(li)}
    section.append(list);host.append(section);
  }
  function attach(card,recording){
    const host=card.matches?.('.recording-content')?card:card.querySelector('.recording-content');if(!host)return;
    const conversations=recording.meeting?.conversations||recording.conversations||[];
    const signature=JSON.stringify([conversations,recording.audioQuality,recording.stats]);if(signatures.get(host)===signature)return;signatures.set(host,signature);
    let details=host.querySelector('.meeting-detail');
    if(!details){details=document.createElement('details');details.className='meeting-detail';host.append(details)}
    const open=details.open;details.replaceChildren(text('summary','Meeting details'));details.open=open;
    const body=document.createElement('div');body.className='meeting-detail-body';details.append(body);
    for(const conversation of conversations){
      const section=document.createElement('section');if(conversations.length>1)section.append(text('h3',conversation.title||'Conversation'));
      group(section,'Chapters',conversation.chapters||[],recording.id);
      group(section,'Decisions',conversation.decisions||[],recording.id);
      group(section,'Actions to review',conversation.action_items||[],recording.id);
      group(section,'Open questions',conversation.unresolved_questions||[],recording.id);
      if(section.querySelector('ul'))body.append(section);
    }
    const quality=root.SynapAudioQuality?.describe(recording.audioQuality,recording.stats)||[];
    if(quality.length){const section=document.createElement('section');section.append(text('h4','Audio quality'));quality.forEach(value=>section.append(text('p',value)));body.append(section)}
    details.hidden=!body.children.length;
  }
  function localPreparation(name,records){
    const key=String(name).trim().toLowerCase(),history=[];
    for(const record of records)for(const c of record.meeting?.conversations||record.conversations||[]){
      if(!(c.people||[]).some(p=>String(p.name||p).toLowerCase()===key)&&!(c.participants||[]).some(p=>String(p).toLowerCase()===key)&&!(c.mentioned_people||[]).some(p=>String(p).toLowerCase()===key))continue;
      history.push({title:c.title,summary:c.summary,started_at:new Date(Date.parse(record.createdAt)+(c.start_ms||0)).toISOString(),source:{recording_id:record.id,start_ms:c.start_ms||0},questions:(c.unresolved_questions||[]).map(q=>({...q,source:{recording_id:record.id,start_ms:q.start_ms}}))});
    }
    history.sort((a,b)=>b.started_at.localeCompare(a.started_at));
    return {history:history.slice(0,12),open_actions:[],scope:'From memories on this device. Sign in to include the current status of cloud actions.'};
  }
  let requestGeneration=0,activeRequest=null;
  function cancelPreparation(){++requestGeneration;activeRequest?.abort();activeRequest=null;}
  async function prepare(person,records){
    cancelPreparation();
    const generation=requestGeneration,section=document.getElementById('peopleMemory');if(!section)return;
    let panel=section.querySelector('.meeting-preparation');if(!panel){panel=document.createElement('div');panel.className='meeting-preparation';section.append(panel)}
    const heading=document.createElement('div');heading.className='meeting-preparation-heading';heading.append(text('h3','Before meeting '+person.name));
    const close=text('button','Close');close.type='button';close.addEventListener('click',()=>{cancelPreparation();panel.remove()});heading.append(close);
    const body=document.createElement('div');body.className='meeting-preparation-content';body.setAttribute('aria-busy','true');body.append(text('p','Loading related conversations…'));
    panel.replaceChildren(heading,body);panel.setAttribute('aria-live','polite');
    let controller=null,timeout=null;
    try{
      let data;
      if(person.id&&root.SynapAuth?.isSignedIn?.()){
        controller=new AbortController();activeRequest=controller;
        let timedOut=false;
        const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error(timedOut?'Meeting preparation timed out. Try again.':'Meeting preparation cancelled.')),{once:true}));
        timeout=root.setTimeout(()=>{timedOut=true;controller.abort()},15000);
        const load=async()=>{
          const response=await root.SynapAuth.authedFetch('/v1/people/'+encodeURIComponent(person.id)+'/preparation',{signal:controller.signal});
          const result=await response.json();
          if(!response.ok)throw new Error(result?.error?.message||'Meeting preparation is unavailable. Try again.');
          if(!result||!Array.isArray(result.history)||!Array.isArray(result.open_actions))throw new Error('Meeting preparation could not be loaded. Try again.');
          return result;
        };
        data=await Promise.race([load(),cancelled]);
      }else data=localPreparation(person.name,records);
      if(generation!==requestGeneration)return;
      body.replaceChildren();
      group(body,'Open actions',data.open_actions||[],'');
      group(body,'Recent conversations',data.history||[],'');
      group(body,'Questions raised', (data.history||[]).flatMap(c=>c.questions||[]),'');
      if(!data.history?.length&&!data.open_actions?.length)body.append(text('p','No related memories yet.'));
      body.append(text('small',data.scope||''));
    }catch(error){
      if(generation!==requestGeneration)return;
      const retry=text('button','Retry');retry.type='button';retry.className='meeting-preparation-retry';retry.addEventListener('click',()=>prepare(person,records));
      body.replaceChildren(text('p',error.message),retry);
    }finally{
      root.clearTimeout(timeout);
      if(activeRequest===controller)activeRequest=null;
      if(generation===requestGeneration)body.setAttribute('aria-busy','false');
    }
  }
  function decoratePeople(people,records){
    for(const card of document.querySelectorAll('#peopleList .person-card')){
      const person=people.find(p=>p.name===card.dataset.person);if(!person)continue;
      const row=document.createElement('div');row.className='person-with-preparation';card.replaceWith(row);row.append(card);
      const button=text('button','Prepare');button.type='button';button.className='meeting-prepare';button.setAttribute('aria-label','Prepare for meeting with '+person.name);button.addEventListener('click',()=>prepare(person,records));row.append(button);
    }
  }
  function init(){root.SynapAuth?.onChange?.(()=>{cancelPreparation();document.querySelector('.meeting-preparation')?.remove()})}
  root.SynapMeetingTools=Object.freeze({attach,decoratePeople,localPreparation});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
