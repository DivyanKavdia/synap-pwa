/* Lightweight measurements only. Quiet audio is never used as a speech gate. */
(function(root){
  'use strict';
  const RATE=16000, WINDOW_SAMPLES=RATE*3;
  let samples=0,squares=0,clipped=0,lowSquares=0,low=0,frames=0,lastReport=0;
  let nearSilentSamples=0,longestNearSilentSamples=0,signalWarning=false;
  let recent=[],recentSamples=0,recentSquares=0,recentClipped=0;
  function reset(){
    samples=squares=clipped=lowSquares=low=frames=lastReport=0;
    nearSilentSamples=longestNearSilentSamples=recentSamples=recentSquares=recentClipped=0;
    recent=[];signalWarning=false;render('');
  }
  function snapshot(){return {samples,rms:samples?Math.sqrt(squares/samples):0,clippedRatio:samples?clipped/samples:0,lowRatio:squares?lowSquares/squares:0,
    recentSamples,recentRms:recentSamples?Math.sqrt(Math.max(0,recentSquares)/recentSamples):0,
    recentClippedRatio:recentSamples?recentClipped/recentSamples:0,
    nearSilentMs:nearSilentSamples/RATE*1000,longestNearSilentMs:longestNearSilentSamples/RATE*1000}}
  function gaps(stats, durationMs) {
    const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
    const missingFrames = count(stats?.missingFrames) + count(stats?.incompleteFrames);
    if (!missingFrames) return null;
    const missingMs = missingFrames * 50;
    const totalMs = Number(durationMs) > 0 ? Number(durationMs) : (count(stats?.completeFrames) + missingFrames) * 50;
    const percent = Math.min(100, Math.round(missingMs / totalMs * 100));
    const duration = (missingMs / 1000).toFixed(2).replace(/\.?0+$/, '');
    return { missingFrames, missingMs, percent, label: duration + ' s missing (' + percent + '%)' };
  }
  function describe(q,stats,{live=false}={}){
    const out=[];if(q?.samples>=48000){
      const recentReady=live&&q.recentSamples>=WINDOW_SAMPLES;
      const silentMs=live?q.nearSilentMs:q.longestNearSilentMs;
      if(silentMs>=3000)out.push('Almost no microphone signal for '+Math.floor(silentMs/1000)+' s'+(live?'': ' during this recording')+'. If you were speaking, check the microphone and its connection.');
      if((recentReady?q.recentClippedRatio:q.clippedRatio)>=.005)out.push('Audio may be distorted by clipping. Move the microphone away from loud sound.');
      if(!(silentMs>=3000)&&(recentReady?q.recentRms:q.rms)<.003)out.push('Very quiet audio. Move the pendant closer if voices are hard to hear.');
      if(q.lowRatio>.85&&q.rms>.05)out.push('Possible rubbing or low-frequency rumble. Keep the microphone opening clear of clothing.');
    }
    const missing=gaps(stats);
    if(missing)out.unshift('Audio incomplete: '+missing.label+'. Missing speech cannot be restored from this saved audio.');
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
    let count=0,energy=0,peaks=0;
    for(let i=0;i+1<view.byteLength;i+=2){
      const sample=view.getInt16(i,true),value=sample/32768;
      energy+=value*value;if(Math.abs(value)>.985)peaks++;
      low+=.055*(value-low);lowSquares+=low*low;count++;
      // PCM arriving at the digital floor is different from missing BLE frames.
      nearSilentSamples=Math.abs(sample)<=2?nearSilentSamples+1:0;
      longestNearSilentSamples=Math.max(longestNearSilentSamples,nearSilentSamples);
    }
    if(!count)return;
    samples+=count;squares+=energy;clipped+=peaks;
    recent.push({count,energy,peaks});recentSamples+=count;recentSquares+=energy;recentClipped+=peaks;
    while(recent.length>1&&recentSamples-recent[0].count>=WINDOW_SAMPLES){
      const old=recent.shift();recentSamples-=old.count;recentSquares-=old.energy;recentClipped-=old.peaks;
    }
    const warning=nearSilentSamples>=WINDOW_SAMPLES;
    if(warning!==signalWarning){
      signalWarning=warning;
      root.dispatchEvent?.(new CustomEvent('synap-audio-signal',{detail:{nearSilent:warning,atMs:samples/RATE*1000,nearSilentMs:nearSilentSamples/RATE*1000}}));
    }
    frames++;const now=Date.now();if(frames%20===0&&now-lastReport>=1000){lastReport=now;render(describe(snapshot(),null,{live:true})[0]||'')}
  }
  root.SynapAudioQuality=Object.freeze({observe,reset,snapshot,describe,gaps,clear:()=>render('')});
})(globalThis);
