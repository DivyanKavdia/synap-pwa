/* Emit one canonical event only after a consolidated memory is durable locally. */
(function(root){
'use strict';
const seen=new Map();let installed=false,scanTimer=0;
function signature(recording){if(!recording)return'';if(!(recording.processingState==='done'||recording.processingStage==='ready'))return'';return String(recording.processedAt||recording.processingUpdatedAt||recording.restoredAt||'ready')}
function emit(recording){const sig=signature(recording);if(!sig)return false;const id=String(recording.id||'');if(!id||seen.get(id)===sig)return false;seen.set(id,sig);if(typeof root.dispatchEvent==='function'&&typeof root.CustomEvent==='function')root.dispatchEvent(new root.CustomEvent('synap-memory-ready',{detail:{recordingId:id,processedAt:recording.processedAt||null,source:recording.restoredFromCloud?'cloud':'processing'}}));return true}
async function scan(quiet=false){if(!root.DKAudioStore)return 0;const journal=new root.DKAudioStore({onError:function(){}});try{await journal.open();const recordings=await journal.all('recordings');let count=0;for(const recording of recordings||[]){const sig=signature(recording);if(!sig)continue;const id=String(recording.id||'');if(!id)continue;if(quiet){seen.set(id,sig);continue}if(emit(recording))count++}return count}catch(_){return 0}}
function schedule(){root.clearTimeout?.(scanTimer);scanTimer=root.setTimeout?root.setTimeout(()=>scan(false),35):0}
function wrapProcessor(){const Processor=root.DKFIFOProcessor;if(!Processor||Processor.prototype.__synapMemoryReadyWrapped)return false;const original=Processor.prototype.execute;if(typeof original!=='function')return false;Processor.prototype.execute=async function(job,config,url){const result=await original.call(this,job,config,url);if(job&&job.kind==='consolidate'){try{const recording=await this.store.get('recordings',job.recordingId);emit(recording)}catch(_){schedule()}}return result};Processor.prototype.__synapMemoryReadyWrapped=true;return true}
function observeQueue(){const node=root.document?.getElementById?.('queueStatus');if(!node||!root.MutationObserver)return;new root.MutationObserver(schedule).observe(node,{childList:true,subtree:true,characterData:true})}
async function init(){if(installed)return;installed=true;wrapProcessor();await scan(true);observeQueue();root.addEventListener?.('synap-processing-state',schedule);root.addEventListener?.('synap-recording-saved',schedule)}
root.SynapMemoryReadyEvents=Object.freeze({scan,emit,wrapProcessor,signature});
if(root.document?.readyState==='loading')root.document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
