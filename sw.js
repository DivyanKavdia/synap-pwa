/* Synap production service worker: network-first code, resilient offline shell. */
const APP_VERSION='1.0.0';
/* app.js owns the client compatibility revision used for update signalling. */
const CLIENT_REVISION='1.0.0-audio2';
/* Refresh the installed shell without changing audio protocol compatibility. */
const UI_RECOVERY_REVISION='1.0.0-navigation1';
const CACHE_REVISION='1.0.0-shell75-navigation';
const CACHE_NAME=`synap-pwa-${CACHE_REVISION}`;
const APP_SHELL=[
  './','./index.html','./theme.js','./styles.css','./brand.css','./compact.css','./brain.css','./polish.css','./settings.css','./library-tools.js','./library-tools.css',
  './touch-event-bridge.js','./battery-v2-ui.js','./event-channel.js','./audio-codec-v3.js','./battery-popover-fix.js','./memory-ui-fix.js','./memory-tools.js','./voice-profile.js','./device-identity.js','./runtime-compat.js','./audio-store.js','./processing-queue.js','./rolling-transcription.js','./capture-stability.js','./ota.js','./releases.js',
  './disconnect-protection.js','./audio-quality.js','./meeting-tools.js','./meeting-tools.css','./app.js','./recording-notifications.js','./moments.js','./speaker-names.js','./settings-panel.js','./enhancements.js','./capture-ui.js','./brain-ui.js','./ask-synap.js','./product-ui.js','./runtime-ui.js','./dashboard-ui.js','./provenance-links.js','./productivity-tools.js','./desktop-capture.js','./interaction-surfaces.js','./memory-ready-events.js','./experience-recovery.js',
  './memory-workspace.js','./action-state.js','./my-actions.js','./compact-layout.js','./audio-enhancement.js','./audio-enhancement-ui.js','./audio-enhancement-worker.js','./vendor/audio-enhancement/rnnoise-sync.js',
  './synap-logo-blue-light.png','./synap-logo-blue-dark.png','./synap-logo-pink-light.png','./synap-logo-pink-dark.png','./synap-logo-lavender-light.png','./synap-logo-lavender-dark.png',
  './ai-providers.js','./sleep-state-guard.js','./recording-bridge.js','./transcript-repair.js','./manifest.webmanifest','./synap-logo-light.png','./synap-logo-dark.png','./icon.svg','./icon-192.png','./icon-512.png',
  './google-auth.js','./synap-backend.js','./processing-recovery.js','./processing-pipeline-ui.js','./cost-ui.js','./synap-account-ui.js','./people-confirm-ui.js','./cloud-history.js'
];
const SCOPE=self.registration?.scope||'https://local.invalid/';
const ORIGIN=self.location?.origin||new URL(SCOPE).origin;
const ENTRY_URL=new URL('./index.html',SCOPE).href;
const ROOT_URL=new URL('./',SCOPE).href;

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

function versionMessage(){return{type:'APP_VERSION',version:APP_VERSION,release:APP_VERSION,revision:CLIENT_REVISION,shellRevision:CACHE_REVISION,uiRecovery:UI_RECOVERY_REVISION}}
self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
  if(event.data?.type==='GET_VERSION'||event.data?.type==='GET_APP_VERSION')event.source?.postMessage(versionMessage());
  if(event.data?.type==='SYNAP_RECORDING_NOTIFICATION')handleRecordingNotification(event);
});

// Notifications address the exact page and take that created them. They never
// start recording, broadcast Stop to other tabs, or queue actions across reload.
const RECORDING_TAG='synap-recording';
let recordingNotificationQueue=Promise.resolve();
function isSynapClient(client){
  if(!client || client.type!=='window')return false;
  try{const url=new URL(client.url);return url.origin===ORIGIN && url.href.startsWith(SCOPE)}catch(_){return false}
}
async function updateRecordingNotification(client,state){
  if(!isSynapClient(client))throw Error('Recording page is unavailable.');
  const notifications=await self.registration.getNotifications({tag:RECORDING_TAG});
  for(const notification of notifications){
    const owner=await self.clients.get(notification.data?.ownerClientId||'');
    if(!owner || (!state?.active && notification.data?.ownerClientId===client.id))notification.close();
    else if(state?.active && notification.data?.ownerClientId!==client.id)
      throw Error('Another Synap page owns the recording notification.');
  }
  if(state?.active!==true)return;
  if(typeof state.sessionId!=='string' || !state.sessionId || state.sessionId.length>160)
    throw Error('Recording session is unavailable.');
  const phase=['recording','interrupted','stopping','saving'].includes(state.phase)?state.phase:'interrupted';
  const title={recording:'Synap is recording',interrupted:'Synap · Connection interrupted',
    stopping:'Synap · Stopping recording',saving:'Synap · Saving recording'}[phase];
  const body={recording:(state.source==='desktop'?'Meeting audio + microphone.':'Pendant audio.')+' Keep Synap open while recording.',
    interrupted:'Waiting to reconnect. Open Synap to check the recording.',
    stopping:'Finishing the current take. Open Synap for progress.',saving:'Saving the audio received on this device.'}[phase];
  const actions=[];
  if(state.canStop===true)actions.push({action:'stop',title:phase==='interrupted'?'Save received audio':'Stop & save'});
  if(state.canMark===true && phase==='recording')actions.push({action:'mark',title:'Mark moment'});
  const options={body,tag:RECORDING_TAG,icon:new URL('./icon-192.png',SCOPE).href,
    silent:true,renotify:false,requireInteraction:true,
    actions:actions.slice(0,Math.max(0,self.Notification?.maxActions||0)),
    data:{kind:RECORDING_TAG,ownerClientId:client.id,sessionId:state.sessionId}};
  if(Number.isFinite(state.startedAt) && state.startedAt>0 && state.startedAt<=Date.now()+1000)
    options.timestamp=state.startedAt;
  await self.registration.showNotification(title,options);
}
function handleRecordingNotification(event){
  const work=recordingNotificationQueue.then(async()=>{
    const client=event.source?.id?await self.clients.get(event.source.id):null;
    await updateRecordingNotification(client,event.data.state);
  });
  // Serialize slow display/close calls so a late Recording update cannot
  // resurrect a notification after Stop has completed.
  recordingNotificationQueue=work.catch(()=>{});
  event.waitUntil(work.then(()=>event.ports?.[0]?.postMessage({ok:true}),
    error=>event.ports?.[0]?.postMessage({ok:false,error:error.message||'Recording notification failed.'})));
}

function sendRecordingAction(client,notification,action){
  return new Promise(resolve=>{
    const channel=new MessageChannel();
    const finish=ok=>{clearTimeout(timer);channel.port1.close();resolve(ok)};
    const timer=setTimeout(()=>finish(false),4000);
    channel.port1.onmessage=event=>finish(event.data?.ok===true);
    try{client.postMessage({type:'SYNAP_RECORDING_ACTION',sessionId:notification.data.sessionId,
      action,expiresAt:Date.now()+4000},[channel.port2])}catch(_){finish(false)}
  });
}
async function openRecordingPage(client){
  if(isSynapClient(client)){try{await client.focus();return}catch(_){}}
  await self.clients.openWindow(ROOT_URL);
}
self.addEventListener('notificationclick',event=>{
  if(event.notification.data?.kind!==RECORDING_TAG)return;
  event.waitUntil((async()=>{
    const client=await self.clients.get(event.notification.data.ownerClientId);
    if(!isSynapClient(client)){
      event.notification.close();
      await openRecordingPage(null);
      return;
    }
    if(['stop','mark'].includes(event.action)){
      const handled=await sendRecordingAction(client,event.notification,event.action);
      if(handled)return;
    }
    await openRecordingPage(client);
  })());
});

async function cached(request){return (await caches.open(CACHE_NAME)).match(request,{ignoreSearch:true})}
async function remember(request,response){
  if(response?.ok){const cache=await caches.open(CACHE_NAME);await cache.put(request,response.clone())}
  return response;
}
async function networkFirst(request){
  try{return await remember(request,await fetch(request,{cache:'no-store'}))}
  catch(error){return await cached(request)||Promise.reject(error)}
}
async function navigation(request){
  try{return await remember(ENTRY_URL,await fetch(request,{cache:'no-store'}))}
  catch(_){return await cached(ENTRY_URL)||await cached(ROOT_URL)||Response.error()}
}
async function cacheFirst(request){
  const hit=await cached(request);
  if(hit){fetch(request).then(response=>remember(request,response)).catch(()=>{});return hit}
  return remember(request,await fetch(request));
}

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==ORIGIN)return;
  if(url.pathname.endsWith('/auth-pair.html')){event.respondWith(networkFirst(event.request));return}
  if(event.request.mode==='navigate'){event.respondWith(navigation(event.request));return}
  const code=/\.(?:js|css|html)$/i.test(url.pathname)||url.pathname.endsWith('/manifest.webmanifest');
  event.respondWith(code?networkFirst(event.request):cacheFirst(event.request));
});
