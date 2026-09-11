/* One saved recording per Worker. RNNoise state stays continuous across bounded reads. */
import createRNNoise from './vendor/audio-enhancement/rnnoise-sync.js';

const FRAME=480, MODEL_DELAY=960, OUTPUT_RATE=16000, MAX_SECONDS=1200;
const READ_SECONDS=1, UP_RADIUS=16, DOWN_RADIUS=48, RING_SIZE=4096;
let started=false;

function tag(view, at) { return String.fromCharCode(...new Uint8Array(view.buffer,view.byteOffset+at,4)); }
async function readWav(blob) {
  if (!(blob instanceof Blob) || blob.size<44 || blob.size>115200044) throw new Error('Choose a PCM WAV recording up to 20 minutes.');
  const initial=new DataView(await blob.slice(0,12).arrayBuffer());
  if (tag(initial,0)!=='RIFF' || tag(initial,8)!=='WAVE') throw new Error('Local enhancement supports mono 16-bit PCM WAV recordings at 16 or 48 kHz.');
  const end=initial.getUint32(4,true)+8;
  if (end>blob.size || end<44) throw new Error('This WAV file is incomplete. Keep the original and try another recording.');
  let format=null, data=null, offset=12, chunks=0;
  while (offset+8<=end) {
    if (++chunks>1024) throw new Error('This WAV file has too many metadata chunks.');
    const info=new DataView(await blob.slice(offset,offset+8).arrayBuffer());
    const kind=tag(info,0), size=info.getUint32(4,true), start=offset+8;
    if (start+size>end) throw new Error('This WAV file has incomplete audio data.');
    if (kind==='fmt ') {
      if (size<16) throw new Error('This WAV file has an invalid audio format.');
      const view=new DataView(await blob.slice(start,start+16).arrayBuffer());
      format={codec:view.getUint16(0,true),channels:view.getUint16(2,true),rate:view.getUint32(4,true),
        byteRate:view.getUint32(8,true),align:view.getUint16(12,true),bits:view.getUint16(14,true)};
    } else if (kind==='data') {
      if (data) throw new Error('Multiple WAV audio chunks are not supported.');
      data={start,size};
    }
    offset=start+size+(size&1);
  }
  if (!format || !data || format.codec!==1 || format.channels!==1 || format.bits!==16 ||
      ![16000,48000].includes(format.rate) || format.align!==2 || format.byteRate!==format.rate*2) {
    throw new Error('Local enhancement supports mono 16-bit PCM WAV recordings at 16 or 48 kHz.');
  }
  if (!data.size || data.size%2) throw new Error('This recording has no complete PCM audio to enhance.');
  const count=data.size/2;
  if (count>format.rate*MAX_SECONDS) throw new Error('Local enhancement supports recordings up to 20 minutes.');
  return {rate:format.rate,count,start:data.start,outputCount:Math.ceil(count*OUTPUT_RATE/format.rate)};
}

function sinc(x) { return Math.abs(x)<1e-12 ? 1 : Math.sin(Math.PI*x)/(Math.PI*x); }
function kernel(radius, cutoff, fraction=0) {
  const taps=new Float64Array(radius*2+1);
  let total=0;
  for (let i=-radius;i<=radius;i++) {
    const distance=i-fraction;
    const window=Math.abs(distance)>radius ? 0 : .42+.5*Math.cos(Math.PI*distance/radius)+.08*Math.cos(2*Math.PI*distance/radius);
    taps[i+radius]=cutoff*sinc(cutoff*distance)*window; total+=taps[i+radius];
  }
  for (let i=0;i<taps.length;i++) taps[i]/=total;
  return taps;
}
// Explicit anti-imaging/anti-alias filters. No AudioContext, device-rate change or full-file decode.
const upKernels=[kernel(UP_RADIUS,.94,0),kernel(UP_RADIUS,.94,1/3),kernel(UP_RADIUS,.94,2/3)];
const downKernel=kernel(DOWN_RADIUS,.30);

async function enhance(blob) {
  const wav=await readWav(blob), duration=wav.count/wav.rate;
  postMessage({type:'progress',value:{stage:'loading',progress:0,processedSeconds:0,durationSeconds:duration}});
  const model=createRNNoise({print:()=>{},printErr:()=>{}});
  await model.ready;
  let state=0, pointer=0;
  try {
    state=model._rnnoise_create(0); pointer=model._malloc(FRAME*4);
    if (!state || !pointer) throw new Error('There is not enough memory to enhance this recording.');
    const ratio=48000/wav.rate, input48=wav.count*ratio;
    const totalFrames=Math.ceil((input48+MODEL_DELAY+DOWN_RADIUS)/FRAME);
    const ring=new Float32Array(RING_SIZE), originalRing=new Float32Array(RING_SIZE);
    let pcm=null, readStart=0, cachedBlock=-1, output=new Uint8Array(OUTPUT_RATE*2), outputView=new DataView(output.buffer);
    let written=0, chunkWritten=0;
    for (let frameIndex=0;frameIndex<totalFrames;frameIndex++) {
      const frameStart=frameIndex*FRAME, nativeStart=Math.floor(frameStart/ratio);
      const block=Math.floor(nativeStart/(wav.rate*READ_SECONDS));
      if (block!==cachedBlock) {
        cachedBlock=block;
        readStart=Math.max(0,block*wav.rate*READ_SECONDS-UP_RADIUS);
        const readEnd=Math.min(wav.count,(block+1)*wav.rate*READ_SECONDS+UP_RADIUS+1);
        pcm=readEnd>readStart ? new DataView(await blob.slice(wav.start+readStart*2,wav.start+readEnd*2).arrayBuffer()) : null;
      }
      const heap=model.HEAPF32, heapOffset=pointer/4;
      for (let j=0;j<FRAME;j++) {
        const absolute=frameStart+j;
        let value=0;
        if (absolute<input48 && pcm) {
          if (ratio===1) value=pcm.getInt16((absolute-readStart)*2,true);
          else {
            const base=Math.floor(absolute/3), taps=upKernels[absolute%3];
            for (let k=-UP_RADIUS;k<=UP_RADIUS;k++) {
              const sample=base+k;
              if (sample>=0 && sample<wav.count) value+=pcm.getInt16((sample-readStart)*2,true)*taps[k+UP_RADIUS];
            }
          }
        }
        heap[heapOffset+j]=value;
        originalRing[absolute%RING_SIZE]=ratio===3 && absolute<input48 && absolute%3===0
          ? pcm.getInt16((absolute/3-readStart)*2,true) : value;
      }
      model._rnnoise_process_frame(state,pointer,pointer);
      // RNNoise 0.2 has a delayed spectrum plus overlap/add: 2 x 480 samples.
      // Flush those frames and trim the delay, preserving source offsets and the final syllable.
      const outputStart=frameStart-MODEL_DELAY;
      for (let j=0;j<FRAME;j++) {
        const at=outputStart+j, value=model.HEAPF32[heapOffset+j];
        if (!Number.isFinite(value)) throw new Error('The local speech model returned invalid audio.');
        if (at>=0) ring[at%RING_SIZE]=value;
      }
      const available=outputStart+FRAME-1;
      while (written<wav.outputCount && written*3+DOWN_RADIUS<=available) {
        const center=written*3;
        let value=0;
        for (let k=-DOWN_RADIUS;k<=DOWN_RADIUS;k++) {
          const at=center+k;
          if (at>=0 && at<input48) value+=ring[at%RING_SIZE]*downKernel[k+DOWN_RADIUS];
        }
        let dry=originalRing[center%RING_SIZE];
        if (wav.rate===48000) {
          dry=0;
          for(let k=-DOWN_RADIUS;k<=DOWN_RADIUS;k++) {
            const at=center+k;
            if(at>=0 && at<input48) dry+=originalRing[at%RING_SIZE]*downKernel[k+DOWN_RADIUS];
          }
        }
        // A denoiser can mistake distant voices or consonants for noise. Bound
        // its correction to 30% of each original sample, keeping the waveform's
        // sign and at least 70% amplitude even if the model outputs silence.
        const limit=Math.abs(dry)*.30;
        value=dry+Math.max(-limit,Math.min(limit,.4*(value-dry)));
        outputView.setInt16(chunkWritten*2,Math.max(-32768,Math.min(32767,Math.round(value))),true);
        written++; chunkWritten++;
        if (chunkWritten===OUTPUT_RATE) {
          postMessage({type:'chunk',buffer:output.buffer},[output.buffer]);
          output=new Uint8Array(OUTPUT_RATE*2); outputView=new DataView(output.buffer); chunkWritten=0;
        }
      }
      if (frameIndex%25===0 || frameIndex===totalFrames-1) {
        postMessage({type:'progress',value:{stage:'processing',progress:written/wav.outputCount,
          processedSeconds:written/OUTPUT_RATE,durationSeconds:duration}});
      }
    }
    if (chunkWritten) { const buffer=output.buffer.slice(0,chunkWritten*2); postMessage({type:'chunk',buffer},[buffer]); }
    if (written!==wav.outputCount) throw new Error('The local speech model could not complete this recording.');
    postMessage({type:'complete',sampleCount:written});
  } finally {
    if (pointer) model._free(pointer);
    if (state) model._rnnoise_destroy(state);
  }
}

self.onmessage=async event => {
  if (started || event.data?.type!=='enhance') return;
  started=true;
  try { await enhance(event.data.blob); }
  catch (error) { postMessage({type:'error',message:error?.message || 'Local speech enhancement failed.'}); }
};
