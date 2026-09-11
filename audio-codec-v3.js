/* Synap audio transport v3: independent-frame IMA ADPCM over BLE.
 * Explicit normalizer: app.js owns the real Web Bluetooth event and calls this
 * codec directly. No host-object/prototype monkey-patching is required, which
 * keeps the transport compatible with Bluefy/WebKit and standards browsers.
 */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.SynapAudioCodecV3=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){'use strict';
  const MAGIC=0xA5,COMPRESSED_VERSION=3,LEGACY_VERSION=2,HEADER_BYTES=8;
  const CODEC_IMA_ADPCM=1,SAMPLES_PER_FRAME=800,PCM_BYTES_PER_FRAME=1600;
  const ADPCM_BYTES_PER_FRAME=404,SYNTHETIC_CHUNKS=4,SYNTHETIC_PAYLOAD=400;
  const STEP_TABLE=[7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
  const INDEX_TABLE=[-1,-1,-1,-1,2,4,6,8];
  const states=new Map();
  const stats={compressedPackets:0,decodedFrames:0,droppedFrames:0,invalidPackets:0};
  function clamp16(v){return v<-32768?-32768:v>32767?32767:v}
  function decodeFrame(input){
    const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
    if(bytes.byteLength!==ADPCM_BYTES_PER_FRAME||bytes[3]!==CODEC_IMA_ADPCM)throw new Error('Invalid Synap ADPCM frame');
    let predictor=bytes[0]|(bytes[1]<<8);if(predictor&0x8000)predictor-=0x10000;
    let index=bytes[2];if(index>88)throw new Error('Invalid Synap ADPCM step index');
    const pcm=new Uint8Array(PCM_BYTES_PER_FRAME),view=new DataView(pcm.buffer);view.setInt16(0,predictor,true);
    for(let sample=1;sample<SAMPLES_PER_FRAME;sample++){
      const packed=bytes[4+((sample-1)>>1)],code=((sample-1)&1)?packed>>4:packed&15,step=STEP_TABLE[index];
      let delta=step>>3;if(code&1)delta+=step>>2;if(code&2)delta+=step>>1;if(code&4)delta+=step;
      predictor=clamp16(predictor+((code&8)?-delta:delta));index=Math.max(0,Math.min(88,index+INDEX_TABLE[code&7]));
      view.setInt16(sample*2,predictor,true);
    }
    return pcm;
  }
  function encodeFrame(input){
    const samples=input instanceof Int16Array?input:new Int16Array(input.buffer||input,input.byteOffset||0,SAMPLES_PER_FRAME);
    if(samples.length!==SAMPLES_PER_FRAME)throw new Error('Synap ADPCM requires 800 PCM samples');
    let predictor=samples[0],index=0;const out=new Uint8Array(ADPCM_BYTES_PER_FRAME);
    out[0]=predictor&255;out[1]=(predictor>>8)&255;out[2]=index;out[3]=CODEC_IMA_ADPCM;
    for(let sample=1;sample<SAMPLES_PER_FRAME;sample++){
      const step=STEP_TABLE[index];let difference=samples[sample]-predictor,code=0;if(difference<0){code=8;difference=-difference}
      let delta=step>>3;if(difference>=step){code|=4;difference-=step;delta+=step}if(difference>=(step>>1)){code|=2;difference-=step>>1;delta+=step>>1}if(difference>=(step>>2)){code|=1;delta+=step>>2}
      predictor=clamp16(predictor+((code&8)?-delta:delta));index=Math.max(0,Math.min(88,index+INDEX_TABLE[code&7]));
      const offset=4+((sample-1)>>1);if((sample-1)&1)out[offset]|=(code&15)<<4;else out[offset]=code&15;
    }
    return out;
  }
  function keyFor(key){return key||'default'}
  function clean(now){for(const [key,state] of states){for(const [seq,frame] of state.frames){if(now-frame.createdAt>2000){state.frames.delete(seq);stats.droppedFrames++}}if(!state.frames.size&&now-state.lastSeen>5000)states.delete(key)}}
  function stateFor(key,now){key=keyFor(key);let state=states.get(key);if(!state){state={frames:new Map(),lastSeen:now};states.set(key,state)}state.lastSeen=now;return state}
  function legacyPackets(sequence,pcm){const output=[];for(let chunk=0;chunk<SYNTHETIC_CHUNKS;chunk++){const packet=new Uint8Array(HEADER_BYTES+SYNTHETIC_PAYLOAD),view=new DataView(packet.buffer);packet[0]=MAGIC;packet[1]=LEGACY_VERSION;view.setUint16(2,sequence,true);packet[4]=chunk;packet[5]=SYNTHETIC_CHUNKS;view.setUint16(6,SYNTHETIC_PAYLOAD,true);packet.set(pcm.subarray(chunk*SYNTHETIC_PAYLOAD,(chunk+1)*SYNTHETIC_PAYLOAD),HEADER_BYTES);output.push(view)}return output}
  function normalizePacket(value,key){
    if(!value||value.byteLength<HEADER_BYTES)return [value];
    if(value.getUint8(0)!==MAGIC||value.getUint8(1)!==COMPRESSED_VERSION)return [value];
    stats.compressedPackets++;
    const sequence=value.getUint16(2,true),chunk=value.getUint8(4),total=value.getUint8(5),length=value.getUint16(6,true);
    if(!total||total>20||chunk>=total||!length||length!==value.byteLength-HEADER_BYTES){stats.invalidPackets++;return []}
    const now=Date.now();clean(now);const state=stateFor(key,now);let frame=state.frames.get(sequence);
    if(!frame){frame={total,chunks:new Array(total),received:0,bytes:0,createdAt:now};state.frames.set(sequence,frame)}
    if(frame.total!==total){state.frames.delete(sequence);stats.invalidPackets++;return []}
    if(frame.chunks[chunk])return [];
    frame.chunks[chunk]=new Uint8Array(value.buffer,value.byteOffset+HEADER_BYTES,length).slice();frame.received++;frame.bytes+=length;
    if(frame.received!==frame.total)return [];
    state.frames.delete(sequence);
    if(frame.bytes!==ADPCM_BYTES_PER_FRAME||frame.chunks.some(part=>!part)){stats.droppedFrames++;return []}
    const encoded=new Uint8Array(ADPCM_BYTES_PER_FRAME);let offset=0;for(const part of frame.chunks){encoded.set(part,offset);offset+=part.byteLength}
    try{const pcm=decodeFrame(encoded);stats.decodedFrames++;return legacyPackets(sequence,pcm)}catch(error){stats.invalidPackets++;console.warn('[synap audio] ADPCM frame decode failed',error);return []}
  }
  function reset(key){if(key===undefined)states.clear();else states.delete(keyFor(key))}
  return {MAGIC,COMPRESSED_VERSION,LEGACY_VERSION,CODEC_IMA_ADPCM,SAMPLES_PER_FRAME,PCM_BYTES_PER_FRAME,ADPCM_BYTES_PER_FRAME,decodeFrame,encodeFrame,normalizePacket,reset,stats};
});
