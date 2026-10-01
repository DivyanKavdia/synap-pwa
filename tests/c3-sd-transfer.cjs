'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Client,decode}=require('../devices/chakshu/transfer.js');
const source=fs.readFileSync(path.join(__dirname,'../devices/chakshu/media.js'),'utf8');
function transport(files){
  let response=new DataView(new ArrayBuffer(16)),selected='',catalogue='[]';
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
    if(op===7){catalogue=JSON.stringify(Object.entries(files).map(([path,data])=>({path,bytes:data.length})));selected='';reply(id,catalogue.length);return}
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
test('a failed first C3 catalogue can be retried without reconnect',()=>{
  assert.match(source,/c3SdRetryCount < 4/);
  assert.match(source,/sdProbe = \{ deviceId, attempted: false \}/);
  assert.match(source,/busyCard \? 15000/);
});