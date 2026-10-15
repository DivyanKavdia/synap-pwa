'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const releases=require('../releases.js'),ota=require('../ota.js'),profiles=require('../devices/profiles.js');
const old='esp32c3-supermini-4m',upgrade='esp32c3-supermini-4m-sd-ota',fresh='esp32c3-supermini-4m-sd';
const identity='SYNAP-FW:'+old+':synap-os1-build2119:2119';

function manifest(target,size) {
  const cfg=profiles.BY_TARGET[target],build=2123,hash='a'.repeat(64);
  return {schema:3,target,version:'synap-os1-build2123',build,protocol:3,chip:cfg.chip,
    partition:cfg.partition,flashBytes:cfg.flashBytes,psramBytes:cfg.psramBytes,
    size,sha256:hash,commit:'b'.repeat(40),
    identity:'SYNAP-FW:'+(cfg.firmwareTarget||target)+':synap-os1-build2123:2123',
    url:'https://raw.githubusercontent.com/DivyanKavdia/synap-firmware/ota-releases/'+cfg.releasePrefix+'builds/2123-'+hash+'.bin',
    channel:'production',provenance:{provider:'github-actions',repository:'DivyanKavdia/synap-firmware',workflow:'.github/workflows/firmware.yml'}};
}
function catalog() {
  return {__synapTargetCatalog:true,manifests:{
    [old]:manifest(old,865000),[upgrade]:manifest(upgrade,1517312),[fresh]:manifest(fresh,1517312)
  }};
}
const status=(capacity)=>({protocol:3,state:1,capacity,maxData:240,build:2119});
test('large OTA manifest retains original running firmware marker, not the factory SD identity',()=>{
  const cfg=profiles.BY_TARGET[upgrade];
  assert.equal(cfg.firmwareTarget,old);
  assert.equal(cfg.marker,profiles.BY_TARGET[old].marker);
  assert.notEqual(cfg.marker,profiles.BY_TARGET[fresh].marker);
  assert.equal(cfg.maxSize,1966080);
  assert.equal(releases.validateManifest(manifest(upgrade,1517312)).identity,'SYNAP-FW:'+old+':synap-os1-build2123:2123');
});
test('small legacy C3 always stays on original 1.25MiB update feed',()=>{
  const c=catalog();
  assert(releases.compatible(c,status(1310720),identity));
  assert.equal(c.target,old);
  const tooSmall=catalog().manifests[upgrade];
  assert.throws(()=>releases.compatible(tooSmall,status(1310720),identity),/inactive slot too small/);
});
test('pre-provisioned existing C3 with 1.875MiB OTA can select BLE-only OTA with original identity',()=>{
  const c=catalog();
  assert(releases.compatible(c,status(1966080),identity));
  assert.equal(c.target,upgrade);
  assert.equal(c.identity,'SYNAP-FW:'+old+':synap-os1-build2123:2123');
  assert.equal(releases.selectCatalogManifest(catalog(),identity,status(1966080)).target,upgrade);
});
test('new factory C3+SD identity stays on separate target',()=>{
  const c=catalog();
  const newIdentity='SYNAP-FW:'+fresh+':synap-os1-build2119:2119';
  assert(releases.compatible(c,status(1966080),newIdentity));
  assert.equal(c.target,fresh);
});
test('BLE updater uses C3 pacing and only validates requested OTA image marker',()=>{
  const cfg=profiles.BY_TARGET[upgrade],image=new Uint8Array(512);
  image[0]=0xe9;const dv=new DataView(image.buffer);
  dv.setUint16(12,5,true);dv.setUint32(32,0xABCD5432,true);
  image.set(new TextEncoder().encode(cfg.marker),64);
  assert.equal(ota.validateImage(image,1966080,3,upgrade),upgrade);
  assert.throws(()=>ota.validateImage(image,1966080,3,fresh),/selected synap hardware target/);
  assert.equal(ota.transferPlan(upgrade,503).windowChunks,ota.transferPlan(old,503).windowChunks);
});

test('enhanced C3 never falls back to legacy firmware if the enhanced C3+SD feed is absent',()=>{
  const value=catalog();
  delete value.manifests[upgrade];
  assert.throws(()=>releases.selectCatalogManifest(value,identity,status(1966080)),/enhanced C3\+SD firmware feed is missing/);
  assert.throws(()=>releases.compatible(manifest(old,865000),status(1966080),identity),/only the large-slot C3\+SD BLE firmware/);
  assert.doesNotThrow(()=>releases.compatible(manifest(old,865000),status(1310720),identity));
});
