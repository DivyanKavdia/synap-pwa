/* Production release feed for device-ID OTA: multi-target S3/C3, browser-safe verification. */
(function(root){
  'use strict';
  const TARGET='esp32s3-fh4r2-qspi-4m';
  const TARGETS=Object.freeze({
    [TARGET]:Object.freeze({target:TARGET,chip:9,flashBytes:4194304,psramBytes:2097152,partition:'default',maxSize:0x140000,marker:'SYNAP-ESP32S3-OTA-ID-V3',manifestPath:'latest.json',releasePrefix:''}),
    'esp32c3-supermini-4m':Object.freeze({target:'esp32c3-supermini-4m',chip:5,flashBytes:4194304,psramBytes:0,partition:'default',maxSize:0x140000,marker:'SYNAP-ESP32C3-OTA-ID-V3',manifestPath:'targets/esp32c3-supermini-4m/latest.json',releasePrefix:'targets/esp32c3-supermini-4m/'})
  });
  const REPOSITORY='DivyanKavdia/synap-firmware';
  const RELEASE_BRANCH='ota-releases';
  const WORKFLOW='.github/workflows/firmware.yml';
  const BASE=`https://raw.githubusercontent.com/${REPOSITORY}/${RELEASE_BRANCH}/`;
  const API=`https://api.github.com/repos/${REPOSITORY}`;
  const IDENTITY_UUID='4fa1234b-0000-1000-8000-00805f9b34fb';
  const LEGACY_UNSIGNED_MAX_BUILD=1008;
  const SIGNING_KEY_ID='prod-2026-01';
  const SIGNING_PUBLIC_KEY_SPKI='MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEupYML35H78nn+VUqkHS15RrxYX86EsMOhBOaAkWriN/qn1r4SqguBfaha7l7sgKVRQ53VUA3sWWS0/MrcynUNQ==';
  const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
  const b64bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  const configFor=target=>TARGETS[target]||null;
  const expectedUrl=(config,build,sha256)=>`${BASE}${config.releasePrefix}builds/${build}-${sha256}.bin`;
  // Keep deployed semantic versions readable while binding OS1 names to the OTA counter.
  const validVersion=(version,build)=>typeof version==='string'&&(/^\d+\.\d+\.\d+$/.test(version)||version===`synap-os1-build${build}`);
  function versionLabel(firmware){
    const {version,build}=firmware||{};
    if(!validVersion(version,build))return `build ${build}`;
    return version.startsWith('synap-os1-build')?version:`${version} · build ${build}`;
  }

  function canonicalManifest(m){return JSON.stringify({schema:m.schema,version:m.version,build:m.build,target:m.target,protocol:m.protocol,chip:m.chip,flashBytes:m.flashBytes,psramBytes:m.psramBytes,partition:m.partition,size:m.size,sha256:m.sha256,commit:m.commit,identity:m.identity,url:m.url,channel:m.channel});}

  function validateManifest(m){
    const config=configFor(m?.target);
    const legacy=m?.schema===1&&m?.target===TARGET&&m.build<=LEGACY_UNSIGNED_MAX_BUILD&&m.channel===undefined;
    const signed=m?.schema===2&&m.channel==='production';
    const github=m?.schema===3&&m.channel==='production';
    if(!config||(!legacy&&!signed&&!github)||m.protocol!==3||m.chip!==config.chip||m.partition!==config.partition||m.flashBytes!==config.flashBytes||m.psramBytes!==config.psramBytes||!integer(m.build,504,65535)||!integer(m.size,288,config.maxSize)||!validVersion(m.version,m.build)||!/^[a-f0-9]{64}$/.test(m.sha256)||!/^[a-f0-9]{40}$/.test(m.commit)||m.identity!==`SYNAP-FW:${config.target}:${m.version}:${m.build}`||m.url!==expectedUrl(config,m.build,m.sha256)) throw Error('Invalid or incompatible firmware release manifest.');
    if(signed&&(!m.signing||m.signing.alg!=='ES256'||m.signing.keyId!==SIGNING_KEY_ID||!/^[A-Za-z0-9+/]{86}==$/.test(m.signing.value))) throw Error('Production firmware manifest is not signed by synap.');
    if(github&&(m.signing||m.provenance?.provider!=='github-actions'||m.provenance?.repository!==REPOSITORY||m.provenance?.workflow!==WORKFLOW)) throw Error('Production firmware manifest has invalid GitHub provenance metadata.');
    if(legacy&&(m.signing||m.provenance)) throw Error('Legacy firmware manifest must not contain trust metadata.');
    return Object.freeze({...m,signing:m.signing?Object.freeze({...m.signing}):undefined,provenance:m.provenance?Object.freeze({...m.provenance}):undefined});
  }

  async function boundedResponse(response,limit){
    if(!response.ok){const error=Error(`Firmware server returned HTTP ${response.status}.`);error.status=response.status;throw error;}
    const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>limit)throw Error('Firmware response exceeds size limit.');
    const reader=response.body?.getReader();
    if(!reader){const b=new Uint8Array(await response.arrayBuffer());if(b.length>limit)throw Error('Firmware response exceeds size limit.');return b;}
    const chunks=[];let length=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit)throw Error('Firmware response exceeds size limit.');chunks.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const result=new Uint8Array(length);let offset=0;for(const b of chunks){result.set(b,offset);offset+=b.length;}return result;
  }

  async function request(url,limit,fetcher=root.fetch.bind(root),signal){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    try{
      if(signal?.aborted)controller.abort();
      const isApi=url.startsWith('https://api.github.com/');
      const headers=isApi?{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}:{};
      return await boundedResponse(await fetcher(url,{cache:'no-store',credentials:'omit',redirect:'follow',headers,signal:controller.signal}),limit);
    }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
  }
  const json=async(url,limit,fetcher)=>JSON.parse(new TextDecoder().decode(await request(url,limit,fetcher)));

  let verifyKeyPromise=null;
  async function verifyLegacySignature(manifest){
    if(!root.crypto?.subtle)throw Error('This browser cannot verify signed firmware releases.');
    if(!verifyKeyPromise)verifyKeyPromise=root.crypto.subtle.importKey('spki',b64bytes(SIGNING_PUBLIC_KEY_SPKI),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    const key=await verifyKeyPromise,ok=await root.crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,b64bytes(manifest.signing.value),new TextEncoder().encode(canonicalManifest(manifest)));
    if(!ok)throw Error('Firmware publisher signature verification failed. Nothing was flashed.');
  }

  /*
   * Schema-3 manifests are generated only by the firmware GitHub Action and are
   * tightly constrained to this repository, workflow, branch, exact target,
   * content-addressed binary URL, commit SHA, build identity and SHA-256.
   *
   * Earlier PWA builds also queried GitHub REST (commit/contents/attestations)
   * during every check. Mobile users can legitimately receive HTTP 403 from
   * GitHub's unauthenticated REST rate limits, making public firmware appear
   * unavailable. Runtime OTA therefore no longer depends on GitHub REST.
   * Image SHA-256 and embedded target/build identity are still verified before
   * flashing. Publisher provenance remains enforced when the release is built.
   */
  async function verifyGitHubProvenance(manifest){validateManifest(manifest);return true;}

  async function verifyManifest(m,fetcher){const manifest=validateManifest(m);if(manifest.schema===1)return manifest;if(manifest.schema===2)await verifyLegacySignature(manifest);else await verifyGitHubProvenance(manifest,fetcher);return manifest;}

  function targetFromIdentity(identity){
    if(typeof identity!=='string')return null;const parts=identity.split(':');
    if(parts.length!==4||parts[0]!=='SYNAP-FW'||!configFor(parts[1])||!validVersion(parts[2],Number(parts[3]))||!integer(Number(parts[3]),504,65535)||String(Number(parts[3]))!==parts[3])return null;
    return {target:parts[1],version:parts[2],build:Number(parts[3])};
  }
  function isCatalog(value){return Boolean(value&&value.__synapTargetCatalog===true&&value.manifests);}
  function catalog(manifests){return {__synapTargetCatalog:true,manifests:Object.freeze({...manifests})};}
  function selectCatalogManifest(value,identity){const running=targetFromIdentity(identity);if(!running)throw Error('Unknown pendant hardware. Reconnect and check the firmware identity.');const selected=value.manifests[running.target];if(!selected)throw Error(`No production firmware is published for ${running.target}.`);return selected;}
  function materializeCatalog(value,identity){const selected=selectCatalogManifest(value,identity);for(const key of Object.keys(value))delete value[key];Object.assign(value,selected);return value;}
  function compatible(m,info,identity){
    if(isCatalog(m))materializeCatalog(m,identity);const manifest=validateManifest(m);
    if(info.protocol!==3)throw Error(root.SynapOTA.MIGRATION_MESSAGE);
    if(info.state===0||info.capacity<manifest.size||info.maxData<64)throw Error('This pendant needs compatible OTA slots and BLE MTU before updating.');
    const running=targetFromIdentity(identity);if(!running)throw Error('Unknown pendant hardware. Reconnect and check the firmware identity.');
    if(running.target!==manifest.target||running.build!==info.build)throw Error('The connected pendant is a different hardware target.');
    return manifest.build>info.build;
  }

  async function latest(fetcher=root.fetch.bind(root)){
    const primary=await verifyManifest(await json(BASE+'latest.json?t='+Date.now(),8192,fetcher),fetcher);
    let index;try{index=await json(BASE+'targets.json?t='+Date.now(),16384,fetcher);}catch(_){return primary;}
    if(index?.schema!==1||index.primary!==TARGET||index.build!==primary.build||index.channel!=='production'||!index.targets||typeof index.targets!=='object')return primary;
    const manifests={[primary.target]:primary};
    for(const [target,path] of Object.entries(index.targets)){
      const config=configFor(target);if(!config||path!==config.manifestPath||target===primary.target)continue;
      const manifest=await verifyManifest(await json(BASE+path+'?t='+Date.now(),8192,fetcher),fetcher);
      if(manifest.target!==target||manifest.build!==index.build)throw Error('Firmware target catalog contains mismatched releases.');manifests[target]=manifest;
    }
    return Object.keys(manifests).length>1?catalog(manifests):primary;
  }

  async function download(m,capacity,fetcher=root.fetch.bind(root),signal){
    const manifest=await verifyManifest(m,fetcher),config=configFor(manifest.target);if(manifest.size>capacity)throw Error('Firmware does not fit this pendant.');
    const bytes=await request(manifest.url,manifest.size,fetcher,signal);if(bytes.length!==manifest.size)throw Error('Firmware download is incomplete.');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==manifest.sha256)throw Error('Firmware download SHA-256 mismatch. Nothing was flashed.');
    root.SynapOTA.validateImage(bytes,capacity,3,manifest.target);
    const marker=new TextEncoder().encode(manifest.identity+'\0');let found=false;for(let i=0;i<=bytes.length-marker.length;i++){if(marker.every((b,j)=>bytes[i+j]===b)){found=true;break;}}
    if(!found)throw Error('Firmware image target/build does not match the release.');if(!config)throw Error('Unknown firmware hardware target.');return new Blob([bytes],{type:'application/octet-stream'});
  }

  root.SynapReleases={TARGET,TARGETS,REPOSITORY,RELEASE_BRANCH,WORKFLOW,BASE,API,IDENTITY_UUID,LEGACY_UNSIGNED_MAX_BUILD,SIGNING_KEY_ID,SIGNING_PUBLIC_KEY_SPKI,canonicalManifest,validateManifest,verifyManifest,verifyGitHubProvenance,targetFromIdentity,versionLabel,compatible,latest,download,isCatalog,selectCatalogManifest};
  if(typeof module!=='undefined')module.exports=root.SynapReleases;
})(globalThis);
