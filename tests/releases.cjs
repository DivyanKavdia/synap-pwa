const {test}=require('node:test'),assert=require('node:assert/strict'),cryptoNode=require('node:crypto');
const ota=require('../ota.js'),r=require('../releases.js');

function fixture(targetId=r.TARGET,build=1001,schema=1,version='1.0.0'){
  const config=r.TARGETS[targetId],bytes=Buffer.alloc(512);bytes[0]=0xe9;bytes.writeUInt16LE(config.chip,12);bytes.writeUInt32LE(0xabcd5432,32);
  bytes.write(config.marker,80);
  const identity=`SYNAP-FW:${targetId}:${version}:${build}`;bytes.write(identity+'\0',160);
  const sha256=cryptoNode.createHash('sha256').update(bytes).digest('hex');
  const m={schema,target:targetId,protocol:3,chip:config.chip,partition:config.partition,flashBytes:config.flashBytes,psramBytes:config.psramBytes,
    build,version,size:bytes.length,sha256,identity,commit:'a'.repeat(40),url:r.BASE+config.releasePrefix+`builds/${build}-${sha256}.bin`};
  if(schema===3){m.channel='production';m.provenance={provider:'github-actions',repository:r.REPOSITORY,workflow:r.WORKFLOW};}
  return {bytes,m};
}

test('both targets migrate from legacy firmware to OS1 and retain monotonic OTA eligibility',async()=>{
  const manifests=Object.fromEntries(Object.keys(r.TARGETS).map(target=>[target,fixture(target,1194,3,'synap-os1-build1194').m]));
  for(const target of Object.keys(r.TARGETS)){
    const {bytes,m}=fixture(target,1194,3,'synap-os1-build1194');
    const info={protocol:3,state:1,capacity:2048,maxData:173,build:1192};
    const catalog={__synapTargetCatalog:true,manifests};
    assert(r.compatible(catalog,info,`SYNAP-FW:${target}:1.0.0:1192`));
    assert.equal(catalog.target,target);
    assert.equal((await r.download(m,2048,async()=>new Response(bytes))).size,bytes.length);
    assert.deepEqual(r.targetFromIdentity(m.identity),{target,version:m.version,build:m.build});
    assert.equal(r.compatible(m,{...info,build:1194},m.identity),false,'rebooted firmware is recognized without reinstalling');
    const next=fixture(target,1195,3,'synap-os1-build1195').m;
    assert(r.compatible(next,{...info,build:1194},m.identity));
    assert.equal(r.compatible(m,{...info,build:1195},next.identity),false,'an older counter stays ineligible');
    assert.equal(r.versionLabel(m),'synap-os1-build1194');
  }
  assert.equal(r.versionLabel({version:'1.0.0',build:1192}),'1.0.0 · build 1192');
});

test('OS1 versions cannot disagree with their manifest or BLE counter',()=>{
  for(const version of ['synap-os1-build1193','synap-os1-build01194','synap-os1-build#','synap-os2-build1194','synap-os1-build1194\n']){
    const {m}=fixture(r.TARGET,1194,3,version);
    assert.throws(()=>r.validateManifest(m),/manifest/);
    assert.equal(r.targetFromIdentity(m.identity),null);
  }
  assert.equal(r.targetFromIdentity(`SYNAP-FW:${r.TARGET}:synap-os1-build1194:01194`),null);
});

test('release manifests validate hardware-specific S3 and C3 constraints',()=>{
  const {m}=fixture();assert.equal(r.validateManifest(m).build,1001);
  const c3=fixture('esp32c3-supermini-4m',1010,3).m;assert.equal(r.validateManifest(c3).target,'esp32c3-supermini-4m');assert.equal(c3.psramBytes,0);assert.equal(c3.chip,5);
  for(const [key,value] of [['target','esp32'],['url','https://evil.test/firmware.bin'],['build',65536],['size',0x140001],['sha256','bad'],['protocol',1],['partition','huge_app'],['identity','wrong']]){
    assert.throws(()=>r.validateManifest({...m,[key]:value}),/manifest/,key);
  }
});

test('connected firmware identity selects exactly one target from a release catalog',()=>{
  const s3=fixture(r.TARGET,1001).m,c3=fixture('esp32c3-supermini-4m',1001,3).m;
  const catalog={__synapTargetCatalog:true,manifests:{[r.TARGET]:s3,'esp32c3-supermini-4m':c3}};
  const info={protocol:3,state:1,capacity:2048,maxData:173,build:1000};
  assert(r.compatible(catalog,info,'SYNAP-FW:esp32c3-supermini-4m:1.0.0:1000'));
  assert.equal(catalog.target,'esp32c3-supermini-4m','catalog is materialized to the selected device target for the existing app update flow');
  assert.throws(()=>r.compatible(fixture().m,{...info,protocol:2},'SYNAP-FW:'+r.TARGET+':1.0.0:1000'),/USB once/);
  assert.throws(()=>r.compatible(fixture().m,info,null),/Unknown/);
  assert.throws(()=>r.compatible(fixture().m,info,'SYNAP-FW:esp32c3-supermini-4m:1.0.0:1000'),/hardware/);
  assert.equal(r.compatible(fixture().m,{...info,build:1001},fixture().m.identity),false,'no repeat install');
});

test('unsigned legacy feed remains S3-only through deployed build 1008',async()=>{
  assert.equal((await r.verifyManifest(fixture(r.TARGET,1008).m)).build,1008);
  assert.throws(()=>r.validateManifest(fixture('esp32c3-supermini-4m',1008).m),/manifest/);
  const future=fixture(r.TARGET,1009).m;assert.throws(()=>r.validateManifest(future),/manifest/);
  const signedShape={...future,schema:2,channel:'production',signing:{alg:'ES256',keyId:r.SIGNING_KEY_ID,value:'A'.repeat(86)+'=='}};
  assert.equal(r.validateManifest(signedShape).schema,2);
  await assert.rejects(r.verifyManifest(signedShape),/signature/);
});

test('download verifies bounded size, digest, S3 image header and exact build before flashing',async()=>{
  const {bytes,m}=fixture();let options;
  const fetcher=async(url,opts)=>{assert.equal(url,m.url);options=opts;return new Response(bytes);};
  const blob=await r.download(m,2048,fetcher);assert.equal(blob.size,512);
  assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'follow');
  await assert.rejects(r.download(m,2048,async()=>new Response(bytes.subarray(0,500))),/incomplete/);
  await assert.rejects(r.download(m,2048,async()=>new Response(Buffer.alloc(513))),/size limit/);
  await assert.rejects(r.download(m,2048,async()=>new Response(Buffer.alloc(512))),/SHA-256/);
  await assert.rejects(r.download(m,2048,async()=>new Response('',{status:404})),/HTTP 404/);
  const bad=Buffer.from(bytes);bad[0]=0;const sha256=cryptoNode.createHash('sha256').update(bad).digest('hex');
  await assert.rejects(r.download({...m,sha256,url:r.BASE+`builds/1001-${sha256}.bin`},2048,async()=>new Response(bad)),/application/);
  assert.equal((await r.latest(async()=>new Response(JSON.stringify(m)))).build,1001,'old single-target feed remains usable when targets.json is absent or invalid');
});

test('device-ID targeting remains independent of owner keys while publisher authenticity is provenance-bound',()=>{
  assert.equal(r.OwnerVault,undefined);assert.equal(ota.importOwnerKey,undefined);
  assert.equal(r.TARGET,'esp32s3-fh4r2-qspi-4m');assert.equal(r.TARGETS['esp32c3-supermini-4m'].chip,5);
  assert.equal(r.SIGNING_KEY_ID,'prod-2026-01');assert.match(r.SIGNING_PUBLIC_KEY_SPKI,/^[A-Za-z0-9+/=]+$/);
});
