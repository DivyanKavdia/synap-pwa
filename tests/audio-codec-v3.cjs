'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const codec=require(path.join(__dirname,'../audio-codec-v3.js'));
function rmsError(left,right){let total=0;for(let i=0;i<left.length;i++){const d=left[i]-right[i];total+=d*d}return Math.sqrt(total/left.length)}
function packetize(encoded,sequence,total){const payload=Math.ceil(encoded.length/total),out=[];for(let chunk=0;chunk<total;chunk++){const from=chunk*payload,to=Math.min(encoded.length,from+payload);if(from>=to)break;const part=encoded.subarray(from,to),packet=new Uint8Array(8+part.length),view=new DataView(packet.buffer);packet[0]=codec.MAGIC;packet[1]=codec.COMPRESSED_VERSION;view.setUint16(2,sequence,true);packet[4]=chunk;packet[5]=total;view.setUint16(6,part.length,true);packet.set(part,8);out.push(view)}return out}
function restore(outputs){const pcm=new Uint8Array(1600);outputs.forEach((value,index)=>{assert.equal(value.getUint8(0),codec.MAGIC);assert.equal(value.getUint8(1),2);assert.equal(value.getUint8(4),index);assert.equal(value.getUint8(5),4);assert.equal(value.getUint16(6,true),400);pcm.set(new Uint8Array(value.buffer,value.byteOffset+8,400),index*400)});return pcm}
test('IMA ADPCM frame stays independent and intelligible',()=>{const pcm=new Int16Array(codec.SAMPLES_PER_FRAME);for(let i=0;i<pcm.length;i++)pcm[i]=Math.round(Math.sin(i*.071)*12000+Math.sin(i*.013)*1800);const encoded=codec.encodeFrame(pcm),decoded=new Int16Array(codec.decodeFrame(encoded).buffer);assert.equal(encoded.byteLength,404);assert.equal(encoded[3],codec.CODEC_IMA_ADPCM);assert.equal(decoded.length,pcm.length);assert.ok(rmsError(pcm,decoded)<500)});
for(const total of [1,3,4,20])test(`protocol-v3 frame normalizes from ${total} BLE chunk(s) without browser prototype hooks`,()=>{codec.reset();const pcm=new Int16Array(codec.SAMPLES_PER_FRAME);for(let i=0;i<pcm.length;i++)pcm[i]=Math.round(Math.sin(i*.05)*9000);const encoded=codec.encodeFrame(pcm),sequence=300+total,packets=packetize(encoded,sequence,total),outputs=[];for(const value of packets)outputs.push(...codec.normalizePacket(value,'test'));assert.equal(outputs.length,4);assert(outputs.every(value=>value.getUint16(2,true)===sequence));assert.deepEqual(restore(outputs),codec.decodeFrame(encoded))});
test('legacy protocol-v2 packet passes through unchanged',()=>{const packet=new Uint8Array(408),view=new DataView(packet.buffer);packet[0]=codec.MAGIC;packet[1]=2;assert.deepEqual(codec.normalizePacket(view,'legacy'),[view])});
test('production app owns normalization explicitly and codec does not patch Web Bluetooth host objects',()=>{const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),source=fs.readFileSync(path.join(__dirname,'../audio-codec-v3.js'),'utf8');assert.ok(html.indexOf('audio-codec-v3.js')>=0&&html.indexOf('audio-codec-v3.js')<html.indexOf('app.js'));assert.match(app,/SynapAudioCodecV3\?\.normalizePacket/);assert.match(app,/handleNormalizedAudioValue/);assert.doesNotMatch(source,/EventTarget|BluetoothRemoteGATTCharacteristic|patchService|patchCharacteristic|addEventListener=function/)});
test('progressing compressed fragments survive congestion while duplicates cannot extend expiry',t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});codec.reset();
  const encoded=codec.encodeFrame(new Int16Array(800).fill(100)),packets=packetize(encoded,51,20),output=[];
  for(const packet of packets){output.push(...codec.normalizePacket(packet,'slow'));t.mock.timers.tick(200);}
  assert.equal(output.length,4);assert.deepEqual(restore(output),codec.decodeFrame(encoded));
  codec.reset();codec.normalizePacket(packets[0],'duplicates');t.mock.timers.tick(1500);
  codec.normalizePacket(packets[0],'duplicates');t.mock.timers.tick(501);
  const dropped=codec.stats.droppedFrames;
  for(const packet of packets.slice(1))assert.deepEqual(codec.normalizePacket(packet,'duplicates'),[]);
  assert.equal(codec.stats.droppedFrames,dropped+1);
});
