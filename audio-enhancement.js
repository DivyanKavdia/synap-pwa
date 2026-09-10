/* Optional local noise reduction. Originals and transcription inputs are never mutated. */
(function (root) {
  'use strict';
  const source = root.document?.currentScript?.src || root.location?.href;
  const workerURL = source ? new URL('audio-enhancement-worker.js?v=1', source).href : '';
  const limits = Object.freeze({ maxDurationSeconds:1200, maxBytes:115200044,
    inputSampleRates:Object.freeze([16000,48000]), outputSampleRate:16000 });
  let active = false;
  function supported() { return !!(root.Worker && root.WebAssembly && root.Blob); }
  function abortError() { return new DOMException('Speech enhancement cancelled.', 'AbortError'); }
  function header(sampleCount) {
    const buffer = new ArrayBuffer(44), view = new DataView(buffer);
    function text(at, value) { for (let i=0;i<value.length;i++) view.setUint8(at+i,value.charCodeAt(i)); }
    text(0,'RIFF'); view.setUint32(4,36+sampleCount*2,true); text(8,'WAVE'); text(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,16000,true); view.setUint32(28,32000,true); view.setUint16(32,2,true);
    view.setUint16(34,16,true); text(36,'data'); view.setUint32(40,sampleCount*2,true);
    return buffer;
  }
  function enhance(blob, {signal,onProgress} = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!supported()) return Promise.reject(new Error('Local speech enhancement needs WebAssembly and Web Workers in this browser.'));
    if (active) return Promise.reject(new Error('Another recording is being enhanced. Wait or cancel it first.'));
    if (!(blob instanceof root.Blob) || blob.size<44) return Promise.reject(new Error('Choose a saved PCM WAV recording to enhance.'));
    if (blob.size>limits.maxBytes) return Promise.reject(new Error('Local enhancement supports recordings up to 20 minutes.'));
    active = true;
    return new Promise((resolve,reject) => {
      let worker, settled = false, samples = 0;
      const parts = [];
      const progress = value => { if (typeof onProgress === 'function') { try { onProgress(value); } catch (_) {} } };
      function finish(error, result) {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort',cancel);
        if (worker) { worker.onmessage=worker.onerror=worker.onmessageerror=null; worker.terminate(); }
        parts.length=0; active=false;
        if (error) reject(error); else resolve(result);
      }
      function cancel() { finish(abortError()); }
      signal?.addEventListener('abort',cancel,{once:true});
      if (signal?.aborted) { cancel(); return; }
      try {
        worker = new root.Worker(workerURL,{type:'module',name:'synap-speech-enhancement'});
        worker.onerror = event => {
          event.preventDefault?.();
          finish(new Error('The local speech model could not run. Reopen Synap online once to refresh its app files, then retry.'));
        };
        worker.onmessageerror = () => finish(new Error('The local enhancement result could not be read. Please retry.'));
        worker.onmessage = event => {
          if (settled) return;
          const message = event.data || {};
          if (message.type==='progress') progress(message.value);
          else if (message.type==='chunk') { parts.push(message.buffer); samples+=message.buffer.byteLength/2; }
          else if (message.type==='error') finish(new Error(message.message || 'Local speech enhancement failed.'));
          else if (message.type==='complete') {
            if (samples!==message.sampleCount) { finish(new Error('The enhanced copy was incomplete. Please retry.')); return; }
            const result = new root.Blob([header(samples),...parts],{type:'audio/wav'});
            finish(null,result);
            progress({stage:'complete',progress:1,processedSeconds:samples/16000,durationSeconds:samples/16000});
          }
        };
        progress({stage:'loading',progress:0,processedSeconds:0,durationSeconds:0});
        // Blob structured cloning shares immutable audio; it does not transfer or rewrite the source.
        worker.postMessage({type:'enhance',blob});
      } catch (error) { finish(error); }
    });
  }
  root.SynapAudioEnhancement = Object.freeze({enhance,supported,busy:()=>active,limits});
})(typeof window!=='undefined' ? window : globalThis);
