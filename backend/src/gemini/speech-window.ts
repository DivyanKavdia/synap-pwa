import { parsePcm16Wav, makePcm16Wav } from '../speaker/audio.js';

/** Only digital silence is excluded. Quiet voices and uncertain noise stay intact. */
export function speechWindow(audio:Buffer):{audio:Buffer;offsetMs:number;silent:boolean} {
  const unchanged={audio,offsetMs:0,silent:false};
  try {
    if(audio.readUInt32LE(4)+8!==audio.length)return unchanged;
    const {data,sampleRate}=parsePcm16Wav(audio);
    if(!data.length || data.length%2)return unchanged;
    let first=-1,last=-1;
    for(let i=0;i<data.length;i+=2)if(Math.abs(data.readInt16LE(i))>2){if(first<0)first=i/2;last=i/2;}
    if(first<0)return {...unchanged,silent:true};
    const count=data.length/2,padding=sampleRate/2;
    const frame=sampleRate/50;
    const start=Math.max(0,Math.floor((first-padding)/frame)*frame),end=Math.min(count,Math.ceil((last+1+padding)/frame)*frame);
    // Avoid making a new copy unless there is at least one second to save.
    if(count-(end-start)<sampleRate)return unchanged;
    return {audio:makePcm16Wav(data.subarray(start*2,end*2),sampleRate),offsetMs:start/sampleRate*1000,silent:false};
  }catch{return unchanged;}
}
