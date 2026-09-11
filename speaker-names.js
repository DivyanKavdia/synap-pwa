/* Names are per-recording annotations; source words and timestamps stay intact. */
(function(root){
  'use strict';
  const states=new WeakMap();
  const busy=()=>['recording','starting','stopping','saving','updating'].includes(document.body.dataset.state);
  async function requestPath(path,options){
    if(!root.SynapAuth?.isSignedIn?.())throw new Error('Sign in to Synap Cloud to name speakers and update summaries.');
    const response=await root.SynapAuth.authedFetch(path,options||{});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error?.message||(response.status===404?'This recording is not available in Synap Cloud.':'Speaker names could not be saved. Try again.'));
    return data;
  }
  const request=(id,options)=>requestPath('/v1/recordings/'+encodeURIComponent(id)+'/speakers',options);
  function attach(card,recording){
    const transcript=card.querySelector('.recording-transcript');if(!transcript)return;
    card=transcript.closest('.recording-content')||card;
    const existing=states.get(card);if(existing){existing.record=recording;return}
    const details=document.createElement('details');details.className='speaker-names';
    details.innerHTML='<summary>Name speakers</summary><p class="speaker-names-hint">Confirm or correct names, then save to update summaries. Remember a confirmed voice once to identify it in future recordings. Leave a name blank to restore its label.</p><form><fieldset class="speaker-name-fields"></fieldset><div class="speaker-name-actions"><button type="submit">Save names & update summaries</button><button type="button" class="speaker-names-reload">Reload speakers</button></div></form><p class="speaker-names-status" role="status" aria-live="polite"></p><details class="known-speakers"><summary>Remembered voices</summary><p class="speaker-names-hint">Encrypted and private to your account. Removing a voice stops future matching; existing memories stay unchanged.</p><div class="known-speaker-list"></div></details>';
    transcript.before(details);
    const state={record:recording,loaded:false,busy:false,data:null};states.set(card,state);
    const form=details.querySelector('form'),fields=details.querySelector('fieldset'),status=details.querySelector('[role="status"]'),save=form.querySelector('[type="submit"]'),reload=form.querySelector('[type="button"]');
    function pending(value){state.busy=value;fields.disabled=value;save.disabled=value||!fields.children.length;reload.disabled=value}
    const directory=details.querySelector('.known-speakers'),voiceList=directory.querySelector('.known-speaker-list');
    async function loadVoices(){
      voiceList.textContent='Loading…';
      try{
        const data=await requestPath('/v1/known-speakers');voiceList.replaceChildren();
        for(const voice of data.speakers||[]){
          const row=document.createElement('div'),name=document.createElement('span'),remove=document.createElement('button');
          row.className='known-speaker-row';name.textContent=voice.name;remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label','Remove saved voice for '+voice.name);
          remove.addEventListener('click',async()=>{
            if(!root.confirm('Remove the saved voice for '+voice.name+'? Future recordings will no longer identify it automatically.'))return;
            remove.disabled=true;
            try{await requestPath('/v1/known-speakers/'+encodeURIComponent(voice.id),{method:'DELETE'});await loadVoices()}
            catch(error){status.textContent=error.message;remove.disabled=false}
          });row.append(name,remove);voiceList.append(row);
        }
        if(!voiceList.children.length)voiceList.textContent=data.available===false?'Speaker recognition is temporarily unavailable.':'No remembered voices yet.';
      }catch(error){voiceList.textContent=error.message}
    }
    directory.addEventListener('toggle',()=>{if(directory.open)void loadVoices()});
    async function load(){
      if(state.busy)return;
      pending(true);status.textContent='Loading speaker labels…';
      try{
        const data=await request(state.record.id);state.data=data;fields.replaceChildren();
        for(const speaker of data.speakers||[]){
          const row=document.createElement('div'),label=document.createElement('label'),title=document.createElement('strong'),excerpt=document.createElement('small'),input=document.createElement('input'),remember=document.createElement('button');
          title.textContent=speaker.label;excerpt.textContent=speaker.excerpt;input.type='text';input.maxLength=80;input.autocomplete='off';input.placeholder='Speaker name';input.dataset.speakerLabel=speaker.label;input.value=data.speaker_names?.[speaker.label]||'';input.setAttribute('aria-label','Name for '+speaker.label);
          remember.type='button';remember.className='remember-speaker';remember.textContent='Remember this voice';remember.setAttribute('aria-label','Remember voice for '+speaker.label);
          remember.addEventListener('click',async()=>{
            if(state.busy)return;
            if(busy()){status.textContent='Stop and save the current recording first.';return}
            const name=input.value.trim();
            if(!name || !state.data.names_confirmed || state.data.speaker_names?.[speaker.label]!==name){status.textContent='Save and confirm this name before remembering the voice.';return}
            if(!root.confirm('Remember '+name+' for future speaker identification? Only continue if you have this person’s permission. Synap will store an encrypted voice fingerprint in your account; no extra audio copy is saved.'))return;
            pending(true);status.textContent='Creating a saved voice from clear speech…';
            try{
              await requestPath('/v1/recordings/'+encodeURIComponent(state.record.id)+'/remember-speaker',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:speaker.label,revision:state.data.revision,consent:true})});
              status.textContent='Voice remembered. Future recordings can identify '+name+'.';if(directory.open)await loadVoices();
            }catch(error){status.textContent=error.message}
            finally{pending(false)}
          });
          row.className='speaker-name-field';label.append(title,excerpt,input);row.append(label,remember);fields.appendChild(row);
        }
        state.loaded=true;status.textContent=fields.children.length?(data.names_confirmed===false&&Object.keys(data.speaker_names||{}).length?'Suggested voice matches. Review the names before confirming.':''):'No speaker labels were found in this transcript. Speaker naming needs a transcript processed with speaker labels.';
      }catch(error){status.textContent=error.message}
      finally{pending(false)}
    }
    details.addEventListener('toggle',()=>{if(details.open&&!state.loaded)void load()});
    reload.addEventListener('click',()=>void load());
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(state.busy||!state.data||!fields.children.length)return;
      if(busy()){status.textContent='Stop and save the current recording before updating summaries.';return}
      if(state.record.provider&&state.record.provider!=='synap'){status.textContent='Speaker naming is available for recordings processed with Synap Cloud.';return}
      const names=Object.fromEntries([...fields.querySelectorAll('input')].map(input=>[input.dataset.speakerLabel,input.value.trim()]));
      if(Object.values(names).some(name=>/[:\x00-\x1f\x7f]/.test(name))){status.textContent='Use names without colons or line breaks.';return}
      pending(true);status.textContent='Updating names and summaries…';
      try{
        const memory=await request(state.record.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({speaker_names:names,revision:state.data.revision})});
        await root.SynapTranscriptRepair.saveMemory(state.record.id,memory);
        state.data.revision=memory.revision;state.data.speaker_names=memory.speaker_names;state.data.names_confirmed=memory.names_confirmed;
        transcript.value=memory.transcript;
        for(const name of ['synap-memory-ready','synap-cloud-history-updated'])root.dispatchEvent(new CustomEvent(name,{detail:{recordingId:state.record.id,source:'speaker-names'}}));
        status.textContent=memory.day_updated===false?'Names and summaries saved. The daily review refresh is pending.':'Names and summaries updated.';
      }catch(error){status.textContent=error.message+' Your entries are kept; retry saving, or reload speakers if this recording changed.'}
      finally{pending(false)}
    });
    save.disabled=true;
  }
  root.SynapSpeakerNames=Object.freeze({attach});
})(globalThis);
