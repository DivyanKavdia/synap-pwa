const {test}=require('node:test'),assert=require('node:assert/strict');
const ota=require('../ota.js');
const fs=require('node:fs'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');

function image(target,size=512){
  const config=ota.IMAGE_TARGETS[target],bytes=new Uint8Array(size);bytes[0]=0xE9;
  new DataView(bytes.buffer).setUint16(12,config.chip,true);
  new DataView(bytes.buffer).setUint32(32,0xABCD5432,true);
  bytes.set(new TextEncoder().encode(config.marker),64);
  return bytes;
}

test('OTA image validator accepts both known hardware targets and rejects cross-target images',()=>{
  const s3='esp32s3-fh4r2-qspi-4m',c3='esp32c3-supermini-4m';
  assert.equal(ota.validateImage(image(s3),2048,3,s3),s3);
  assert.equal(ota.validateImage(image(c3),2048,3,c3),c3);
  assert.equal(ota.validateImage(image(c3),2048,3),c3,'client can infer the target after release verification');
  assert.throws(()=>ota.validateImage(image(s3),2048,3,c3),/selected synap hardware target/);
  const wrong=image(c3);new DataView(wrong.buffer).setUint16(12,9,true);
  assert.throws(()=>ota.validateImage(wrong,2048,3,c3),/selected synap hardware target/);
});


test('Odyssey C3 pre-1445 connection reserves BLE for OTA recovery',()=>{
  assert.match(app,/\^SYNAP-FW:esp32c3-supermini-4m:\[\^:\]\+:\(\\d\+\)\$/);
  assert.match(app,/recoveryBuild > 0 && recoveryBuild < 1445/);
  assert.match(app,/document\.body\.dataset\.otaRecovery = "c3"/);
  assert.match(app,/Bluetooth is reserved for firmware update\. SD and media checks are paused until build 1445 is installed\./);
  const recovery=app.indexOf('Odyssey C3 OTA recovery: builds before 1445');
  const optional=app.indexOf('connectionStage("optional features")',recovery);
  assert(recovery>=0 && optional>recovery,'C3 recovery probe must run before optional GATT/media discovery');
  assert.match(app,/document\.body\?\.dataset\.otaRecovery === 'c3' \? 150 : 5000/);
});


test('legacy C3 cannot OTA into new C3+SD generation even with matching ESP32-C3 chip',()=>{
  const old='esp32c3-supermini-4m',modern='esp32c3-supermini-4m-sd';
  const original=image(old),next=image(modern);
  assert.equal(ota.validateImage(original,1310720,3,old),old);
  assert.equal(ota.validateImage(next,1966080,3,modern),modern);
  assert.throws(()=>ota.validateImage(next,1966080,3,old),/selected synap hardware target/);
  assert.throws(()=>ota.validateImage(original,1966080,3,modern),/selected synap hardware target/);
  assert.equal(ota.validateImage(next,1966080,3),modern);
  assert.throws(()=>ota.validateImage(new Uint8Array(1516786),1310720,3,old),/exceeds/);
});
