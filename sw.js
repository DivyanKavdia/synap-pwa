/* Synap production service worker: network-first code, resilient offline shell. */
const APP_VERSION='1.0.0';
/* app.js owns the client compatibility revision used for update signalling. */
const CLIENT_REVISION='1.0.0-audio2';
/* Keep the previous production revision explicit for upgrade diagnostics/tests. */
const PREVIOUS_CACHE_REVISION='1.0.0-shell30-processing-recovery';
const CACHE_REVISION='1.0.0-shell31-dashboard';
const CACHE_NAME=`synap-pwa-${CACHE_REVISION}`;
const APP_SHELL=[
  './','./index.html','./theme.js','./styles.css','./brand.css','./compact.css','./brain.css','./polish.css','./settings-icon-fix.css',
  './touch-event-bridge.js','./battery-v2-ui.js','./event-channel.js','./audio-codec-v3.js','./battery-popover-fix.js','./memory-ui-fix.js','./memory-tools.js','./voice-profile.js','./device-identity.js','./runtime-compat.js','./audio-store.js','./ota.js','./releases.js',
  './app.js','./enhancements.js','./capture-ui.js','./brain-ui.js','./product-ui.js','./runtime-ui.js','./dashboard-ui.js',
  './ai-providers.js','./recording-bridge.js','./manifest.webmanifest','./logo.webp','./icon.svg','./icon-192.png','./icon-512.png',
  './google-auth.js','./synap-backend.js','./processing-recovery.js','./processing-pipeline-ui.js','./synap-account-ui.js','./people-confirm-ui.js','./cloud-history.js'
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

function versionMessage(){return{type:'APP_VERSION',version:APP_VERSION,release:APP_VERSION,revision:CLIENT_REVISION,shellRevision:CACHE_REVISION}}
self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
  if(event.data?.type==='GET_VERSION'||event.data?.type==='GET_APP_VERSION')event.source?.postMessage(versionMessage());
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
  /* The Safari auth handoff is a real HTML document, not an SPA navigation.
     Keep it network-first under its own cache key so visiting it can never
     overwrite the cached Synap index shell. */
  if(url.pathname.endsWith('/auth-pair.html')){event.respondWith(networkFirst(event.request));return}
  if(event.request.mode==='navigate'){event.respondWith(navigation(event.request));return}
  const code=/\.(?:js|css|html)$/i.test(url.pathname)||url.pathname.endsWith('/manifest.webmanifest');
  event.respondWith(code?networkFirst(event.request):cacheFirst(event.request));
});
