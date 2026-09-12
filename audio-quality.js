/* Lightweight measurements only. Quiet audio is never used as a speech gate. */
(function(root){
  'use strict';
  let samples=0,squares=0,clipped=0,lowSquares=0,low=0,frames=0,lastReport=0;
  function reset(){samples=squares=clipped=lowSquares=low=frames=lastReport=0;render('')}
  function snapshot(){return {samples,rms:samples?Math.sqrt(squares/samples):0,clippedRatio:samples?clipped/samples:0,lowRatio:squares?lowSquares/squares:0}}
  function describe(q,stats){
    const out=[];if(q?.samples>=48000){
      if(q.clippedRatio>=.005)out.push('Audio may be distorted by clipping. Move the microphone away from loud sound.');
      if(q.rms<.003)out.push('Very quiet audio. Move the pendant closer if voices are hard to hear.');
      if(q.lowRatio>.85&&q.rms>.05)out.push('Possible rubbing or low-frequency rumble. Keep the microphone opening clear of clothing.');
    }
    const missing=Number(stats?.missingFrames||0)+Number(stats?.incompleteFrames||0);
    if(missing>0)out.push('Some audio frames were missing or incomplete; unheard words cannot be recovered by enhancement.');
    return out;
  }
  function render(value){
    if(!root.document)return;
    let node=document.getElementById('recordingQuality');
    if(!node){const header=document.querySelector('header');if(!header)return;node=document.createElement('div');node.id='recordingQuality';node.className='recording-quality';node.setAttribute('role','status');header.append(node)}
    node.textContent=value;node.hidden=!value;
  }
  function observe(pcm){
    const view=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);
    for(let i=0;i+1<view.byteLength;i+=2){const value=view.getInt16(i,true)/32768;squares+=value*value;if(Math.abs(value)>.985)clipped++;low+=.055*(value-low);lowSquares+=low*low;samples++}
    frames++;const now=Date.now();if(frames%60===0&&now-lastReport>3000){lastReport=now;render(describe(snapshot())[0]||'')}
  }
  root.SynapAudioQuality=Object.freeze({observe,reset,snapshot,describe,clear:()=>render('')});
})(globalThis);
