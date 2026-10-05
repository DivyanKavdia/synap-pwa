'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Client,decode}=require('../devices/chakshu/transfer.js');
const source=fs.readFileSync(path.join(__dirname,'../devices/chakshu/media.js'),'utf8');
const preview=fs.readFileSync(path.join(__dirname,'../devices/chakshu/capture-preview.js'),'utf8');
const modules=fs.readFileSync(path.join(__dirname,'../devices/modules.js'),'utf8');
function transport(files, options={}){
  let response=new DataView(new ArrayBuffer(16)),selected='',catalogue='[]';
  let failCatalogue=Boolean(options.failCatalogueOnce);
  const requests=[];
  const reply=(id,total=0,offset=0,payload=new Uint8Array(),error=0)=>{
    const bytes=new Uint8Array(16+payload.length),v=new DataView(bytes.buffer);
    bytes[0]=0xcb;bytes[1]=1;bytes[2]=error?2:1;bytes[3]=error;
    v.setUint32(4,id,true);v.setUint32(8,total,true);v.setUint32(12,offset,true);bytes.set(payload,16);
    response=v;
  };
  const command={properties:{writeWithoutResponse:true},async writeValueWithoutResponse(b){await write(b)},async writeValueWithResponse(b){await write(b)}};
  async function write(bytes){
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),op=bytes[1],id=v.getUint32(2,true),offset=v.getUint32(6,true);
    const name=new TextDecoder().decode(bytes.subarray(10));requests.push({op,name,offset});
    if(op===7){
      if(failCatalogue){failCatalogue=false;reply(id,0,0,new TextEncoder().encode(JSON.stringify({stage:'catalogue-opendir',errno:5})),7);return}
      catalogue=JSON.stringify(Object.entries(files).map(([path,data])=>({path,bytes:data.length})));selected='';reply(id,catalogue.length);return
    }
    if(op===14){reply(id);return}
    if(op===8){reply(id,catalogue.length);return}
    if(op===3){selected=name;reply(id,files[name]?.length||0);return}
    if(op===4){
      const data=name==='@catalogue'?new TextEncoder().encode(catalogue):files[name||selected];
      if(!data){reply(id,0,offset,new Uint8Array(),11);return}
      reply(id,data.length,offset,data.subarray(offset,offset+480));return;
    }
    reply(id,0);
  }
  const data={async readValue(){return response}};
  const context={mediaFeatures:0,queue:action=>Promise.resolve().then(action),service:{async getCharacteristic(id){return id.includes('2354-')?command:data}}};
  return {client:new Client(context),requests};
}
test('media errors retain machine-readable BUSY for safe C3 retry',()=>{
  const bytes=new Uint8Array(16),v=new DataView(bytes.buffer);
  bytes[0]=0xcb;bytes[1]=1;bytes[2]=2;bytes[3]=1;v.setUint32(4,42,true);
  assert.throws(()=>decode(v,42),e=>e.mediaCode===1);
});
test('C3 catalogue and every WAV chunk use explicit paths',async()=>{
  const path='/synap/odyssey_audio_12345678_87654321.wav',content=new Uint8Array(1200);
  content.forEach((_,i)=>{content[i]=i%251});
  const t=transport({[path]:content}),list=await t.client.catalogue();
  assert.deepEqual(list,[{path,bytes:1200}]);
  const received=new Uint8Array(await (await t.client.file(path)).arrayBuffer());
  assert.deepEqual(received,content);
  assert.ok(t.requests.filter(r=>r.op===4&&r.name===path).length>=3);
  assert.ok(t.requests.some(r=>r.op===4&&r.name==='@catalogue'));
});
test('only transient C3 BUSY catalogue failures are retried automatically',()=>{
  assert.match(source,/const retryAllowed = busyCard && c3SdRetryCount < 8/);
  assert.match(source,/sdProbe = \{ deviceId, attempted: false \}/);
  assert.match(source,/const retryMs = 15000/);
  assert.doesNotMatch(source,/cardInitFailed\s*\?|c3SdRetryCount < 4/);
});
test('C3 IO_ERROR retains catalogue errno and one remount restores listing',async()=>{
  const wav='/synap/odyssey_audio_12345678_87654321.wav';
  const t=transport({[wav]:new Uint8Array(200)},{failCatalogueOnce:true});
  await assert.rejects(t.client.catalogue(),e=>e.mediaCode===7 && e.storage?.errno===5);
  await t.client.request(14);
  const files=await t.client.catalogue();
  assert.deepEqual(files,[{path:wav,bytes:200}]);
  assert.deepEqual(t.requests.map(r=>r.op).slice(0,4),[7,14,7,8]);
});
test('C3 catalogue discovery is observational and never sends op14',()=>{
  const discovery=source.slice(source.indexOf('async function catalogueNow('),source.indexOf('async function catalogue()'));
  assert.match(discovery,/Catalogue discovery is observational/);
  assert.doesNotMatch(discovery,/camera\(\)\.request\(14/);
  assert.match(discovery,/See connection diagnostics for the device error/);
  const refresh=source.slice(source.indexOf('async function refreshSD()'),source.indexOf('function decodeWifi'));
  assert.match(refresh,/camera\(\)\.request\(14, 0, '', signal\)/);
});

test('C3 failed mounts still reach observational catalogue diagnostics',()=>{
  const sync=source.slice(source.indexOf('async function syncPendingSD()'),source.indexOf('const apiObject ='));
  assert.doesNotMatch(sync,/module\.sdDetectionState === 2/);
  assert.match(sync,/const files = await catalogueNow\(\)/);
  assert.doesNotMatch(sync,/camera\(\)\.request\(14/);
});

test('C3 format is firmware-gated and uses explicit destructive op19',()=>{
  assert.match(modules,/profile\.id === 2 \? value\.getUint8\(16\) & 7 : 0/);
  assert.match(preview,/info\?\.id === 2 && \(info\.mediaFeatures & 4\)/);
  assert.match(preview,/await client\(\)\.request\(19\)/);
  assert.match(preview,/ALL files on the card will be permanently erased/);
  assert.match(preview,/formatDeviceSD/);
});
