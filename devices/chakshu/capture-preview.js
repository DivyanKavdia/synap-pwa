/* Immediate feedback for header captures. Preview reads only already-saved camera frames. */
(function (root) {
  'use strict';
  const $ = (id) => document.getElementById(id),
    api = () => root.SynapChakshu;
  let owner = '',
    mode = '',
    mediaId = null,
    epoch = 0,
    rendering = 0,
    busy = false,
    sdCapture = false,
    url = null,
    frameKey = '',
    note = '';
  function release() {
    if (url) URL.revokeObjectURL(url);
    url = null;
    frameKey = '';
    $('capturePreviewImage').removeAttribute('src');
    $('capturePreviewImage').hidden = true;
  }
  function close() {
    ++epoch;
    ++rendering;
    $('capturePreview').close();
    release();
    mediaId = null;
    mode = '';
    sdCapture = false;
    owner = '';
    note = '';
  }
  function begin(kind) {
    close();
    owner = api().state.owner;
    mode = kind;
    busy = true;
    $('capturePreviewTitle').textContent = kind === 'video' ? 'Video preview' : 'Photo preview';
    $('capturePreviewStatus').textContent =
      kind === 'video' ? 'Preparing video and separate audio…' : 'Taking photo…';
    $('capturePreviewWaiting').hidden = false;
    $('capturePreviewWaiting').textContent = 'Waiting for the camera…';
    $('capturePreviewHint').textContent = '';
    for (const id of ['capturePreviewPhoto', 'capturePreviewStop', 'capturePreviewOpen'])
      $(id).disabled = true;
    $('capturePreviewPhoto').hidden = true;
    $('capturePreviewStop').hidden = kind !== 'video';
    $('capturePreviewOpen').hidden = true;
    $('capturePreview').showModal();
    return epoch;
  }
  async function render() {
    if (!$('capturePreview').open) return;
    const state = api().state;
    if (state.owner !== owner || !state.available) {
      close();
      return;
    }
    const token = ++rendering,
      generation = epoch,
      store = api().store;
    if (mode === 'video' && state.session?.id) mediaId = state.session.id;
    const id = mediaId;
    const [row, frame] = id
      ? await Promise.all([store.get(id), store.lastFrame(id)])
      : [null, null];
    if (
      token !== rendering ||
      generation !== epoch ||
      owner !== api().state.owner ||
      store !== api().store
    )
      return;
    if (frame && frameKey !== id + ':' + frame.index) {
      release();
      url = URL.createObjectURL(frame.blob);
      frameKey = id + ':' + frame.index;
      $('capturePreviewImage').src = url;
      $('capturePreviewImage').hidden = false;
    }
    $('capturePreviewWaiting').hidden = Boolean(frame);
    const active = mode === 'video' && Boolean(state.session || state.offline);
    const receiving =
      state.transferProgress && !state.error
        ? state.transferProgress.totalBytes
          ? 'Receiving camera image · ' + state.transferProgress.percent + '%'
          : 'Taking camera image…'
        : '';
    const stopping = state.session?.phase === 'saving';
    if (mode === 'video' && state.offline) sdCapture = true;
    const sd = sdCapture && !mediaId && !state.session && state.offlineStatus;
    $('capturePreviewWaiting').textContent =
      state.error ||
      note ||
      (sd
        ? state.offline
          ? 'Video is recording on the SD card.'
          : 'SD recording finished.'
        : '') ||
      receiving ||
      (active ? 'Waiting for the first video frame…' : 'No camera image yet.');
    $('capturePreviewStatus').textContent =
      note ||
      state.error ||
      (sd
        ? state.offline
          ? 'Recording to SD · ' +
            root.SynapChakshuPlayer.timeLabel(sd.audioMs || 0) +
            ' · ' +
            (sd.frames || 0) +
            ' frames'
          : sd.error
            ? 'Partial recording kept on SD.'
            : 'Video and audio saved to SD.'
        : stopping
          ? 'Saving video and audio…'
          : receiving
            ? receiving
            : active
              ? frame
                ? 'Recording · ' + root.SynapChakshuPlayer.timeLabel(frame.atMs)
                : 'Preparing video and separate audio…'
              : row
                ? row.kind === 'video'
                  ? 'Video saved with audio in your memory library.'
                  : row.previewOnly
                    ? 'Preview saved here. Original photo saved to SD.'
                    : 'Photo saved to your library.'
                : busy
                  ? 'Taking photo…'
                  : 'Capture unavailable.');
    $('capturePreviewHint').textContent = active
      ? stopping
        ? 'Finishing the recording and saving received frames and audio…'
        : 'Closing this preview keeps recording. Use Stop & save video to finish.'
      : sd
        ? 'Open Photos & video in Library to move this recording to the app or download it over Wi-Fi.'
        : row
          ? 'You can review this capture in your library.'
          : '';
    $('capturePreviewPhoto').hidden = mode !== 'video' || !active || Boolean(sd);
    $('capturePreviewPhoto').disabled =
      busy || state.working || state.session?.phase !== 'recording';
    $('capturePreviewStop').hidden = !active;
    $('capturePreviewStop').disabled = busy || stopping || state.session?.phase === 'starting';
    $('capturePreviewOpen').hidden = !row || active;
    $('capturePreviewOpen').disabled = busy || active || !row;
  }
  async function capturePhoto() {
    const token = begin('image');
    try {
      const id = await api().photo();
      if (token === epoch && owner === api().state.owner) mediaId = id;
      return id;
    } catch (error) {
      if (token === epoch) note = error.message;
      throw error;
    } finally {
      if (token === epoch) {
        busy = false;
        await render();
      }
    }
  }
  async function captureVideo() {
    const token = begin('video');
    const current = api().state;
    mediaId = current.session?.id || null;
    try {
      if (current.session || current.offline) await api().stop();
      else await (api().startVideo ? api().startVideo() : api().startLive(false));
    } catch (error) {
      if (token === epoch) note = error.message;
      throw error;
    } finally {
      if (token === epoch) {
        busy = false;
        await render();
      }
    }
  }
  async function act(fn, success = '') {
    if (busy) return;
    const token = epoch;
    busy = true;
    note = '';
    try {
      await render();
      if (token !== epoch || owner !== api().state.owner) return;
      await fn();
      if (token === epoch) note = success;
    } catch (error) {
      if (token === epoch) note = error.message;
    } finally {
      if (token === epoch) {
        busy = false;
        await render();
      }
    }
  }
  function init() {
    $('capturePreviewClose').addEventListener('click', close);
    $('capturePreview').addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    $('capturePreviewPhoto').addEventListener('click', () =>
      act(() => api().photo(), 'Photo saved to your library. Video continues recording.'),
    );
    $('capturePreviewStop').addEventListener('click', () => act(() => api().stop()));
    $('capturePreviewOpen').addEventListener('click', () =>
      act(async () => {
        const id = mediaId,
          token = epoch;
        await root.SynapChakshuLibrary.open(id);
        if (token === epoch) close();
      }),
    );
    root.addEventListener('synap-chakshu-changed', () =>
      render().catch((error) => {
        if ($('capturePreview').open) $('capturePreviewStatus').textContent = error.message;
      }),
    );
  }
  root.SynapChakshuPreview = { photo: capturePhoto, video: captureVideo, close };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);

/* Chakshu v2 lifecycle: verified move-from-SD, FIFO controls and explicit vision. */
(function (root) {
  'use strict';
  const api = () => root.SynapChakshu;
  const RECEIPT_PREFIX = 'synap-chakshu-move-v2:';
  const WIFI_UPLOAD_PREFIX = 'synap-c3-wifi-upload-v1:';
  const pause = (ms) => new Promise((resolve) => root.setTimeout(resolve, ms));
  let busy = false;
  const status = (message) => {
    const node = document.getElementById('visualConnectionStatus'),
      inbox = document.getElementById('librarySDInboxText');
    if (node) node.textContent = message || '';
    if (inbox && message) inbox.textContent = message;
  };
  function context() {
    const state = api()?.state,
      connection = root.SynapDevices?.connection;
    if (!state?.available) throw Error('Sign in and connect a media-capable pendant first.');
    if (!state.connected || !connection?.deviceId)
      throw Error(state?.connectionStatus?.message || 'Connect the pendant first.');
    if (!state.mediaSupported) throw Error('Update pendant firmware for SD media controls.');
    return connection;
  }
  function client() {
    return new root.SynapChakshuTransfer.Client(context());
  }
  function pathOk(path) {
    return /^\/synap\/(?:[a-f0-9]{8}-[a-f0-9]{8}\.(?:jpg|wav|mjpeg|json)|[a-z0-9][a-z0-9._-]{0,51}\.wav)$/i.test(
      path,
    );
  }
  async function digest(blob) {
    const bytes = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function crc32(bytes, start = 0) {
    let crc = 0xffffffff;
    for (let i = start; i < bytes.length; i++) {
      crc = (crc ^ bytes[i]) >>> 0;
      for (let bit = 0; bit < 8; bit++)
        crc = ((crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)) >>> 0;
    }
    return (~crc) >>> 0;
  }
  async function verifyFirmwareCrc(blob, entry) {
    const expected = Number(entry?.crc32);
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > 0xffffffff) return null;
    if (!String(entry?.path || '').toLowerCase().endsWith('.wav')) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 44) throw Error('SD recording is shorter than a WAV header. The SD original was kept.');
    const actual = crc32(bytes, 44);
    if (actual !== expected)
      throw Error('SD recording integrity check failed before import. The SD original was kept.');
    return actual;
  }
  const basename = (path) => path.split('/').pop();
  const stem = (path) => path.replace(/\.[^.]+$/, '');
  // FAT-generated C3 WAV names are uppercase; validate every stage consistently.
  const isWavPath = (path) => /\.wav$/i.test(path);
  const isMjpegPath = (path) => /\.mjpeg$/i.test(path);
  const receiptKey = (deviceId, path) => RECEIPT_PREFIX + deviceId + ':' + path;
  function storedReceipt(path) {
    const connection = root.SynapDevices?.connection,
      owner = api()?.state?.owner;
    if (!connection?.deviceId || !owner) return null;
    try {
      const receipt = JSON.parse(localStorage.getItem(receiptKey(connection.deviceId, path)) || 'null');
      return receipt && receipt.owner === owner && receipt.deviceId === connection.deviceId && receipt.path === path
        ? receipt
        : null;
    } catch (_) {
      return null;
    }
  }
  const isSDSynced = (path) => Boolean(storedReceipt(path));
  const wifiUploadKey = (owner, deviceId, path) =>
    WIFI_UPLOAD_PREFIX + owner + ':' + deviceId + ':' + path;
  function c3WifiSupported() {
    const info = root.SynapModules?.client?.module;
    return Boolean(info?.id === 2 && (info.mediaFeatures & 2));
  }
  // Field failure: a native full-card FAT format returned I/O failure on an
  // otherwise mounted Odyssey C3 and left SD unavailable. Keep the UI and
  // command blocked until the C3 formatter is separately qualified.
  // Bulk Clear remains blocked on C3. Explicit one-file WAV deletion is
  // available only after an idle, verified mount and confirmation; the firmware
  // refuses operation 17 during native read/write quarantine. Never auto-delete
  // a recording after sync or allow an unsafe multi-file cleanup.
  const C3_FULL_CARD_FORMAT_DISABLED = false;
  const C3_SD_MAINTENANCE_WRITES_DISABLED = true;
  function c3MaintenanceWritesBlocked() {
    return C3_SD_MAINTENANCE_WRITES_DISABLED && root.SynapModules?.client?.module?.id === 2;
  }
  const C3_SD_WRITE_SAFETY_MESSAGE = 'Odyssey C3 SD deletion is temporarily disabled: a user-requested FAT delete made storage unavailable after a successful sync. Synced audio stays in Memories and the SD original is retained. Back up and manage the card externally until SD writes are qualified.';
  function c3FormatSupported() {
    const info = root.SynapModules?.client?.module;
    return Boolean(info?.id === 2 && (info.mediaFeatures & 4));
  }
  function c3FormatUnsafe() {
    const info = root.SynapModules?.client?.module;
    // Firmware retains failed SD recording stages (>=40) across restarts.
    // A card that has already timed out on CMD25 must not be subjected to
    // destructive FAT rebuilds until its write reliability is qualified.
    const stage=Number(info?.sdProbeState);
    // Microphone faults and out-of-space are not a trapped SD controller.
    // These remain format-confirmed (never automatic), so a user can clear a
    // genuinely full SD after exporting any readable recordings.
    return Boolean(info?.id === 2 && stage >= 40 &&
      ![43,48,52,68].includes(stage));
  }
  function audioJournal() {
    return new root.DKAudioStore({ ...root.SynapRecordingJournal.options() });
  }
  async function responseJson(response, fallback) {
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw Error(data?.error?.message || fallback || ('HTTP ' + response.status));
    return data || {};
  }
  async function c3WifiStatus() {
    if (!c3WifiSupported()) return null;
    return client().c3WifiStatus();
  }
  // SoftAP downloads do not require stored router/hotspot credentials.
  async function c3ApStatus() {
    if (!c3WifiSupported()) return null;
    return client().c3ApStatus();
  }
  async function startC3Ap() {
    if (!c3WifiSupported()) throw Error('Update Odyssey C3 firmware for private Wi-Fi downloads.');
    // Capture the authenticated BLE device and owner BEFORE op20. The radio
    // can drop GATT after the ACK but before this async continuation resumes.
    const connection=context(), owner=api()?.state?.owner;
    // Mark the radio handoff BEFORE the op20 BLE round trip. iOS may emit a
    // GATT disconnect while the response is being read, before credentials
    // have been returned to this caller.
    c3BridgeHandoffPendingAt=Date.now();
    try {
      const ap=await client().startC3Ap();
      showC3ApInfo(ap,{deviceId:connection.deviceId,owner});
      return ap;
    } finally {
      c3BridgeHandoffPendingAt=0;
      // An unsuccessful handoff must never suppress future BLE reconnection.
      if(!c3BridgeAp?.active)
        root.dispatchEvent(new CustomEvent('synap-c3-ap-handoff-ended'));
    }
  }
  async function stopC3Ap() {
    if (!c3WifiSupported()) return null;
    return client().stopC3Ap();
  }
  function showC3ApInfo(next, trustedIdentity=null) {
    // Cache BLE-delivered credentials BEFORE querying DOM. Keep the verified
    // BLE identity from the op20 request even when GATT drops immediately.
    if(!next?.active) {
      c3BridgeAp=null;
      c3BridgeIdentity=null;
      c3BridgeHandoffStartedAt=0;
      if(c3BridgeExpiryTimer!==null)root.clearTimeout(c3BridgeExpiryTimer);
      c3BridgeExpiryTimer=null;
    } else {
      const differentSession=!c3BridgeAp?.active || c3BridgeAp.url!==next.url;
      c3BridgeAp=next;
      const current=root.SynapDevices?.connection;
      const identity=trustedIdentity || (current?.deviceId && api()?.state?.owner
        ? {deviceId:current.deviceId,owner:api().state.owner}:null);
      if(identity?.deviceId && identity?.owner)c3BridgeIdentity={...identity};
      if(differentSession) {
        c3BridgeHandoffStartedAt=Date.now();
        if(c3BridgeExpiryTimer!==null)root.clearTimeout(c3BridgeExpiryTimer);
        const url=next.url;
        // Firmware shuts its AP down 900 seconds after going live, 4 seconds
        // after op20. Expire the retained handoff state after a small margin:
        // no stale link and no indefinitely disabled BLE autoreconnect.
        c3BridgeExpiryTimer=root.setTimeout(()=>{
          if(c3BridgeAp?.url!==url)return;
          showC3ApInfo(null);
          root.dispatchEvent(new CustomEvent('synap-c3-ap-handoff-ended'));
          renderSDInbox();
        },C3_AP_HANDOFF_MAX_MS);
      }
    }
    const node=document.getElementById('deviceApInfo');
    const link=document.getElementById('deviceApOpen');
    if(!node || !link)return;
    node.hidden=!next?.active;
    link.hidden=!next?.active;
    if(!next?.active){node.textContent='';link.removeAttribute('href');return;}
    node.textContent='Network: '+next.ssid+' · Password: '+next.password+
      ' · Join this Wi-Fi in iPhone Settings, then open the private page.';
    link.href=next.url;
    link.textContent='Open & sync directly into Synap';
    link.removeAttribute('rel');
    link.onclick=(event)=>{
      event.preventDefault();
      try{openC3Bridge();}
      catch(error){status(error.message);}
    };
  }

  // Verified same-window-family bridge for an HTTP-only local SoftAP page.
  // HTTPS Synap MUST NOT fetch HTTP 192.168.4.1 directly (mixed content).
  // The local AP page owns its same-origin fetch and transfers bounded
  // ArrayBuffers to this PWA via a strictly bound opener/origin/session.
  let c3Bridge=null;
  let c3BridgeIdentity=null;
  let c3BridgeAp=null;
  let c3BridgeHandoffPendingAt=0;
  let c3BridgeHandoffStartedAt=0;
  let c3BridgeExpiryTimer=null;
  const C3_AP_HANDOFF_MAX_MS=925000; // 4 s startup + 900 s AP + 21 s margin
  const C3_AP_ORIGIN='http://192.168.4.1';
  const C3_AP_MAX_BYTES=64*1024*1024;
  function c3BridgeToken() {
    const bytes=new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    return [...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  function c3BridgeUrl(ap,channel) {
    const url=new URL(ap.url);
    if(url.origin!==C3_AP_ORIGIN || !/^[a-f0-9]{32}$/.test(url.searchParams.get('key')||''))
      throw Error('The pendant private Wi-Fi link is invalid.');
    url.searchParams.set('bridge',channel);
    url.searchParams.set('origin',root.location.origin);
    return url.href;
  }
  function openC3Bridge() {
    if(!c3BridgeAp?.active || !c3BridgeIdentity?.deviceId || !c3BridgeIdentity?.owner)
      throw Error('Connect the pendant in Synap and start its private Wi-Fi first.');
    if(c3Bridge?.working)throw Error('Finish the previous Wi-Fi import first.');
    const channel=c3BridgeToken();
    const target=c3BridgeUrl(c3BridgeAp,channel);
    // window.open runs synchronously inside the user's click gesture; iOS
    // otherwise blocks delayed/asynchronous popups. No rel=noopener is used.
    const popup=root.open(target,'synapC3Direct');
    if(!popup)throw Error('Browser blocked the private page. Allow popups and open it again from Synap.');
    c3Bridge={channel,popup,identity:{...c3BridgeIdentity},ready:false,working:false,transfer:null};
    status('Direct Wi-Fi import page opened. Select a WAV there. Keep Synap open in its original tab.');
  }
  function c3BridgeAck(event,session,action,seq,ok,error='') {
    try {
      event.source.postMessage({
        type:'synap:c3-ack',version:1,channel:session.channel,
        action,seq,ok,...(error?{error}:{}),
      },C3_AP_ORIGIN);
    } catch (_) {}
  }
  function c3BridgeAccountMatches(session) {
    const owner=api()?.state?.owner;
    const activeUid=root.SynapAuth?.session?.()?.profile?.uid;
    return Boolean(owner && owner===session.identity.owner &&
      activeUid===session.identity.owner);
  }
  async function importC3BridgedWav(session,path,source) {
    const owner=session.identity.owner;
    if(!c3BridgeAccountMatches(session))
      throw Error('Synap account changed. The SD original was kept.');
    if(source.size<44 || source.size>C3_AP_MAX_BYTES)
      throw Error('Invalid SD WAV size.');
    const normalized=await normalizedImportedWav(source);
    const entry=api()?.state?.sdFiles?.find?.(item=>item.path===path);
    if(entry && Number.isSafeInteger(entry.bytes) && entry.bytes!==source.size)
      throw Error('Wi-Fi recording length does not match the original SD catalogue.');
    if(entry?.crc32!==undefined)await verifyFirmwareCrc(source,entry);
    if(!c3BridgeAccountMatches(session))throw Error('Synap account changed.');
    const key=receiptKey(session.identity.deviceId,path);
    const stored=JSON.parse(localStorage.getItem(key)||'null');
    const originalSha=await digest(source);
    const journal=audioJournal();
    if(stored?.owner===owner && stored.deviceId===session.identity.deviceId &&
       stored.path===path && stored.mainSha256===originalSha && stored.audioId) {
      const record=await journal.get('recordings',stored.audioId);
      if(record?.sealed) {
        const saved=await journal.blob(record);
        if(saved.size===stored.audioBytes && await digest(saved)===stored.audioSha256)
          return {audioId:stored.audioId,alreadySynced:true};
      }
    }
    // This is the existing Odyssey SD PCM journal pipeline, reused without
    // any BLE GATT dependency during the disconnected SoftAP session.
    const bytes=new Uint8Array(await source.arrayBuffer());
    const id=await journal.begin('Odyssey SD audio',{deviceId:session.identity.deviceId});
    try {
      for(let at=44,sequence=0;at<bytes.length;at+=1600) {
        if(!c3BridgeAccountMatches(session))throw Error('Account changed during import.');
        const payload=new Uint8Array(1600);
        payload.set(bytes.subarray(at,Math.min(at+1600,bytes.length)));
        journal.append(id,{sequence:sequence++,chunk:0,total:1,payload});
        if(sequence%100===0)await journal.flush();
      }
      await journal.close(id);
      const verified=await verifyAudio(id,source);
      if(!c3BridgeAccountMatches(session))throw Error('Account changed during verification.');
      const receipt={
        schema:1,owner,deviceId:session.identity.deviceId,path,
        audioId:id,visualId:null,mainBytes:source.size,
        mainSha256:originalSha,audioBytes:verified.bytes,
        audioSha256:verified.sha256,transport:'c3-softap-direct',
        savedAt:new Date().toISOString(),
      };
      localStorage.setItem(key,JSON.stringify(receipt));
      root.dispatchEvent(new CustomEvent('synap-recording-saved',{
        detail:{recordingId:id,source:'c3-softap-direct'},
      }));
      root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
      return {audioId:id,alreadySynced:false};
    }catch(error){
      await journal.close(id,'import-interrupted').catch(()=>{});
      throw error;
    }
  }
  root.addEventListener('message',event=>{
    const session=c3Bridge,packet=event.data;
    if(!session || event.origin!==C3_AP_ORIGIN || event.source!==session.popup ||
       !packet || packet.type!=='synap:c3-ap' || packet.version!==1 ||
       packet.channel!==session.channel)return;
    const {action,seq,path}=packet;
    const reply=(ok,error='')=>c3BridgeAck(event,session,action,seq,ok,error);
    if(action==='hello'){
      if(!c3BridgeAccountMatches(session)){reply(false,'Sign in to the original Synap account.');return;}
      session.ready=true;
      try{event.source.postMessage({type:'synap:c3-ack',version:1,channel:session.channel,
        action:'ready',seq:0,ok:true},C3_AP_ORIGIN);}catch(_){}
      status('Wi-Fi connected to Synap. Tap WAV recordings on the private page to sync them.');
      return;
    }
    if(!session.ready || !c3BridgeAccountMatches(session)){reply(false,'Synap account or bridge changed.');return;}
    if(action==='cancel'){
      session.transfer=null;session.working=false;
      status('Wi-Fi transfer interrupted; SD original retained.');
      return;
    }
    if(action==='begin'){
      const size=Number(packet.size);
      if(session.working || !pathOk(path) || !path.toLowerCase().endsWith('.wav') ||
         !Number.isSafeInteger(size) || size<44 || size>C3_AP_MAX_BYTES) {
        reply(false,'Invalid file or another import is active.');return;
      }
      session.working=true;
      session.transfer={path,size,received:0,chunks:[],nextSeq:seq+1};
      reply(true);return;
    }
    const transfer=session.transfer;
    if(!session.working || !transfer || transfer.path!==path){
      reply(false,'Start a valid WAV transfer first.');return;
    }
    if(action==='chunk'){
      const chunk=packet.buffer;
      if(seq!==transfer.nextSeq || !(chunk instanceof ArrayBuffer) ||
         chunk.byteLength===0 || chunk.byteLength>16384 ||
         packet.offset!==transfer.received ||
         transfer.received+chunk.byteLength>transfer.size){
        session.transfer=null;session.working=false;
        reply(false,'Invalid or out-of-order Wi-Fi chunk.');return;
      }
      transfer.chunks.push(chunk);
      transfer.received+=chunk.byteLength;
      transfer.nextSeq++;
      reply(true);
      status('Receiving SD recording over Wi-Fi · '+Math.floor(transfer.received/transfer.size*100)+'%');
      return;
    }
    if(action==='end'){
      if(seq!==transfer.nextSeq || transfer.received!==transfer.size){
        session.transfer=null;session.working=false;
        reply(false,'Incomplete or out-of-order WAV.');return;
      }
      session.transfer=null;
      (async()=>{
        try{
          const source=new Blob(transfer.chunks,{type:'audio/wav'});
          const result=await importC3BridgedWav(session,path,source);
          status(result.alreadySynced?
            'Recording already verified in Synap; SD original retained.':
            'Recording verified in Synap Memories. Cloud processing resumes with internet; SD original retained.');
          reply(true);
        }catch(error){
          status('Wi-Fi import not saved: '+error.message+'. SD original retained.');
          reply(false,error.message);
        }finally{session.working=false;}
      })();
      return;
    }
    reply(false,'Unsupported Wi-Fi bridge message.');
  });

  async function configureC3Wifi(ssid, password) {
    if (!c3WifiSupported()) throw Error('Update Odyssey C3 firmware for direct Wi-Fi sync.');
    return client().configureC3Wifi(ssid, password);
  }
  async function forgetC3Wifi() {
    if (!c3WifiSupported()) return null;
    return client().forgetC3Wifi();
  }
  async function beginC3CloudUpload(path, sourceEntry, connection, owner) {
    if (!root.SynapAuth?.isSignedIn?.()) throw Error('Sign in with Google before using Wi-Fi sync.');
    const bytes = Math.max(0, Number(sourceEntry?.bytes) || 0);
    if (bytes <= 44) throw Error('This SD recording contains no audio to sync.');
    const durationMs = Math.max(1, Math.floor((bytes - 44) / 32));
    const key = wifiUploadKey(owner, connection.deviceId, path);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
    const validId = /^[0-9a-f-]{36}$/i.test(String(saved?.recordingId || ''));
    const recordingId = validId ? saved.recordingId : crypto.randomUUID();
    const firstSeen = Date.parse(sourceEntry?.seenAt || '');
    const endedAtMs = Number.isFinite(firstSeen) ? firstSeen : Date.now();
    const startedAt = new Date(Math.max(0, endedAtMs - durationMs)).toISOString();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const response = await root.SynapAuth.authedFetch('/v1/device-uploads', {
      method: 'POST',
      expectedUid: owner,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recording_id: recordingId,
        device_id: connection.deviceId,
        started_at: startedAt,
        language: 'auto',
        timezone,
      }),
    });
    const ticket = await responseJson(response, 'Synap Cloud could not prepare Wi-Fi sync.');
    if (!ticket.upload_token || ticket.recording_id !== recordingId)
      throw Error('Synap Cloud returned an invalid Wi-Fi upload ticket.');
    localStorage.setItem(key, JSON.stringify({ recordingId, createdAt: new Date().toISOString() }));
    return {
      key,
      recordingId,
      endpoint: root.SynapAuth.config().backendUrl,
      token: ticket.upload_token,
      durationMs,
    };
  }
  async function moveC3Wifi(path, sourceEntry, progress = () => {}) {
    if (busy) throw Error('Another SD transfer is already running.');
    const connection = context(), owner = api().state.owner;
    busy = true;
    renderSDInbox();
    reportSDStage(path, 'wifi-ticket');
    try {
      const ticket = await beginC3CloudUpload(path, sourceEntry, connection, owner);
      if (owner !== api().state.owner || connection !== root.SynapDevices?.connection)
        throw Error('Account or pendant changed before Wi-Fi sync started.');
      reportSDStage(path, 'wifi-start', { recordingId: ticket.recordingId });
      const transfer = client();
      let state = await transfer.startC3WifiUpload({
        endpoint: ticket.endpoint,
        token: ticket.token,
        recordingId: ticket.recordingId,
        path,
      });
      for (;;) {
        const total = Math.max(0, Number(state?.total) || Number(sourceEntry?.bytes) || 0);
        const uploaded = Math.max(0, Number(state?.uploaded) || 0);
        if (total > 44) progress(Math.min(1, uploaded / Math.max(1, total - 44)));
        status(
          state?.message ||
          (state?.active
            ? 'Syncing over Wi-Fi · ' + Math.round(Math.min(1, uploaded / Math.max(1, total - 44)) * 100) + '%'
            : 'Checking Wi-Fi sync…'),
        );
        if (Number(state?.phase) === 6) {
          throw Error(
            String(state?.message || 'Wi-Fi sync failed.') +
              (state?.http ? ' HTTP ' + state.http + '.' : ''),
          );
        }
        if (!state?.active) {
          if (Number(state?.phase) === 5) break;
          throw Error(state?.message || 'Wi-Fi sync stopped before cloud verification.');
        }
        await pause(750);
        if (owner !== api().state.owner || connection !== root.SynapDevices?.connection)
          throw Error('Wi-Fi sync is continuing on the pendant. Reconnect to refresh Memories.');
        state = await transfer.c3WifiStatus();
      }
      progress(1);
      localStorage.removeItem(ticket.key);
      const receipt = {
        schema: 1,
        owner,
        deviceId: connection.deviceId,
        path,
        audioId: ticket.recordingId,
        visualId: null,
        mainBytes: Math.max(0, Number(sourceEntry?.bytes) || 0),
        ...(sourceEntry?.crc32 !== undefined ? { sourceCrc32: sourceEntry.crc32 } : {}),
        ...(sourceEntry?.take ? { take: sourceEntry.take, part: sourceEntry.part ?? null } : {}),
        wifi: true,
        cloud: true,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(receiptKey(connection.deviceId, path), JSON.stringify(receipt));
      reportSDStage(path, 'wifi-verified', { recordingId: ticket.recordingId });
      await root.SynapCloudHistory?.restore?.(true, { limit: 100 }).catch?.(() => {});
      root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
      return { ...receipt, alreadySynced: false, keptOnSD: true };
    } catch (error) {
      reportSDStage(path, 'wifi-failed', { message: error?.message || String(error) });
      throw error;
    } finally {
      busy = false;
      renderSDInbox();
    }
  }
  async function localSnapshot() {
    const visuals = api().store ? await api().store.list() : [];
    const recordings = await audioJournal().all('recordings');
    return {
      visuals: new Set(visuals.map((row) => row.id)),
      recordings: new Set(recordings.map((row) => row.id)),
    };
  }
  async function download(path, signal, progress) {
    if (!pathOk(path)) throw Error('Invalid SD path.');
    const c = client(),
      files = [];
    const add = async (name, required = true) => {
      try {
        const blob = await c.file(name, signal, progress);
        const type = /\.jpg$/i.test(name) ? 'image/jpeg' : isWavPath(name) ? 'audio/wav' : /\.json$/i.test(name) ? 'application/json' : 'video/x-motion-jpeg';
        files.push(new File([blob], basename(name), { type }));
        return blob;
      } catch (error) {
        if (!required && /SD file unavailable/.test(error.message)) return null;
        throw error;
      }
    };
    const main = await add(path);
    let wav = null;
    // Chakshu stores multimedia moments as matching visual/WAV/JSON stems.
    // A still-photo memory can carry a spoken note, not only an MJPEG video.
    // Never issue companion reads on Odyssey C3 or S3 paths.
    if (isMjpegPath(path)) await add(stem(path) + '.json', false);
    if (isMjpegPath(path) ||
        (root.SynapCapabilities?.isChakshu(root.SynapModules?.client?.module) && /\.jpg$/i.test(path)))
      wav = await add(stem(path) + '.wav', false);
    return { files, main, wav };
  }
  async function verifyVisual(id, expectedMain, expectedWav) {
    const store = api().store,
      row = await store.get(id);
    if (!row || row.state !== 'saved') throw Error('The imported visual was not durably saved.');
    const frames = await store.frames(id),
      rebuilt = new Blob(frames.map((frame) => frame.blob), {
        type: row.kind === 'image' ? 'image/jpeg' : 'video/x-motion-jpeg',
      });
    if (rebuilt.size !== expectedMain.size || (await digest(rebuilt)) !== (await digest(expectedMain)))
      throw Error('The saved visual did not match the SD source. The SD original was kept.');
    let verifiedAudio = null;
    if (expectedWav) {
      if (!row.audioId) throw Error('The video soundtrack was not saved. The SD original was kept.');
      verifiedAudio = await verifyAudio(row.audioId, expectedWav);
    }
    return { ...row, verifiedAudio };
  }
  // The journal stores 50ms / 1600-byte PCM frames. ImportAudio pads only
  // the final incomplete frame with zeroes, then regenerates the WAV lengths.
  // Verify the ENTIRE journal WAV against that deterministic transformation,
  // rather than incorrectly comparing its size to the shorter SD original.
  async function normalizedImportedWav(source) {
    if (!(source instanceof Blob) || source.size < 44)
      throw Error('Invalid imported WAV source. The SD original was kept.');
    const header = new Uint8Array(await source.slice(0, 44).arrayBuffer()),
      view = new DataView(header.buffer),
      tag = (at, text) => [...text].every((char, i) => header[at + i] === char.charCodeAt(0)),
      pcmBytes = source.size - 44;
    if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data') ||
        view.getUint32(4, true) !== source.size - 8 ||
        view.getUint32(16, true) !== 16 ||
        view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
        view.getUint32(24, true) !== 16000 || view.getUint32(28, true) !== 32000 ||
        view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
        view.getUint32(40, true) !== pcmBytes || pcmBytes % 2 !== 0)
      throw Error('Invalid imported PCM WAV header. The SD original was kept.');
    const padding = (1600 - (pcmBytes % 1600)) % 1600;
    if (!padding) return source;
    view.setUint32(4, pcmBytes + padding + 36, true);
    view.setUint32(40, pcmBytes + padding, true);
    return new Blob([header, source.slice(44), new Uint8Array(padding)], { type: 'audio/wav' });
  }
  async function verifyAudio(id, expected) {
    const journal = audioJournal(),
      record = await journal.get('recordings', id);
    if (!record || !record.sealed) throw Error('The imported audio is still saving. The SD original was kept.');
    const saved = await journal.blob(record),
      normalized = await normalizedImportedWav(expected);
    const savedHash = saved.size === normalized.size ? await digest(saved) : null;
    if (!savedHash || savedHash !== (await digest(normalized)))
      throw Error('The saved audio did not match the SD source after frame alignment. The SD original was kept.');
    // Receipts must track the actual sealed journal WAV, not the shorter SD
    // bytes: otherwise every reconnect invalidates receipts and reimports.
    return { record, bytes: saved.size, sha256: savedHash };
  }
  async function verifyReceipt(receipt) {
    if (!receipt || receipt.owner !== api().state.owner || receipt.deviceId !== root.SynapDevices?.connection?.deviceId)
      return false;
    try {
      if (receipt.visualId) {
        const row = await api().store.get(receipt.visualId);
        if (!row || row.state !== 'saved') return false;
        const frames = await api().store.frames(receipt.visualId),
          rebuilt = new Blob(frames.map((frame) => frame.blob));
        if (rebuilt.size !== receipt.mainBytes || (await digest(rebuilt)) !== receipt.mainSha256) return false;
      }
      if (receipt.audioId) {
        const journal = audioJournal(),
          record = await journal.get('recordings', receipt.audioId);
        if (!record || !record.sealed) return false;
        const blob = await journal.blob(record);
        if (blob.size !== receipt.audioBytes || (await digest(blob)) !== receipt.audioSha256) return false;
      }
      return Boolean(receipt.visualId || receipt.audioId);
    } catch (_) {
      return false;
    }
  }
  async function deleteSD(path, optional = false) {
    // Field 2026-10-18: op17 unlink returned EIO after a verified C3 sync.
    // Do not send this FAT-mutating command even from older PWA flows.
    if (root.SynapModules?.client?.module?.id === 2)
      throw Error('Odyssey C3 SD deletion is paused after a confirmed FAT write fault. The SD original and verified Memories copy are retained. Back up/manage SD via a card reader; do not retry BLE delete or format.');
    // Chakshu and unaffected modules retain their explicit delete workflow.
    try {
      const reply = await client().request(17, 0, path);
      return reply.total;
    } catch (error) {
      if (optional && /SD file unavailable/.test(error.message)) return 0;
      if (error?.mediaCode === 1 && root.SynapModules?.client?.module?.id === 2) {
        // Busy is overloaded by the C3 media protocol: recorder/OTA/storage
        // contention OR the firmware's trusted low-battery FAT write guard.
        // Older builds enforced an ADC-voltage threshold; latest firmware
        // removes SD battery admission checks. BUSY can also mean contention.
        // Never retry a destructive operation blindly.
        throw Error('C3 refused SD deletion (busy). Stop recording/OTA and retry only when SD is idle and ready. Latest firmware no longer uses a battery-voltage threshold for SD actions; older firmware may still enforce one. The SD file was not confirmed deleted.');
      }
      throw error;
    }
  }
  async function deleteSyncedSet(path) {
    // Delete video companions first. If cleanup is interrupted, keeping the
    // MJPEG primary prevents its soundtrack from surfacing as standalone audio.
    if (isMjpegPath(path)) {
      await deleteSD(stem(path) + '.json', true);
      await deleteSD(stem(path) + '.wav', true);
    }
    return deleteSD(path);
  }
  async function deleteSDItem(path) {
    // Refuse BEFORE any SD command; never allow a C3 unlink to damage the
    // mounted card that just completed a verified read-only BLE transfer.
    if (root.SynapModules?.client?.module?.id === 2)
      throw Error('Odyssey C3 Delete from SD is paused: FAT unlink made the card unavailable after sync. Files are retained; use a card reader after backup.');
    if (busy) throw Error('Another SD transfer is already running.');
    const connection = context();
    const originalOwner = api().state.owner;
    // The BLE link may change during the C3's post-unlink settle interval.
    // Never let a different device (or account) prove that the original SD
    // file is gone: that would drop its durable local sync receipt.
    const assertSameConnection = () => {
      if (root.SynapDevices?.connection !== connection ||
          api()?.state?.owner !== originalOwner) {
        reportSDStage(path, 'delete-unverified-link-changed');
        throw Error('SD connection changed before deletion was verified. The sync receipt is preserved. Reconnect to the original pendant and refresh SD.');
      }
    };
    if (api().state.offline || api().state.session || root.SynapAppControls?.recordingState?.().active)
      throw Error('Stop recording before deleting from the SD card.');
    if (!api().state.storageReady)
      throw Error('SD card access is not ready. A write/read fault may have suspended access; preserve existing WAVs and fully power-cycle the SD card before trying again.');
    busy = true;
    renderSDInbox();
    try {
      reportSDStage(path, 'delete-user-requested');
      const requestedAt = Date.now();
      try {
        await deleteSyncedSet(path);
      } catch (error) {
        reportSDStage(path, 'delete-command-failed', { message: error.message });
        throw error;
      }
      reportSDStage(path, 'delete-command-confirmed', { elapsedMs: Date.now() - requestedAt });
      // C3 SDSPI has shown a FAT catalogue EIO immediately after a verified
      // unlink. Give the card an idle window before any further FAT reads.
      // This NEVER repeats unlink, remounts, formats or assumes deletion.
      const isC3 = root.SynapModules?.client?.module?.id === 2;
      if (isC3) {
        const settleMs = 6000;
        reportSDStage(path, 'delete-sd-settling', { settleMs });
        await new Promise((resolve) => root.setTimeout(resolve, settleMs));
      }
      // Firmware ACK alone is not enough: only forget the verified sync
      // receipt after a fresh on-card catalogue confirms the exact path gone.
      // A failed SD read or BLE drop must not claim deletion success.
      assertSameConnection();
      let fresh;
      try {
        fresh = await api().catalogue();
      } catch (error) {
        // op27 is a read-only NVS/RAM diagnostic snapshot: it sends NO
        // additional command to a potentially busy SD card. Capture the
        // CURRENT media op/step/errno, not only an old recorder CMD25 fault.
        if (isC3) {
          try {
            const reply = await client().request(27);
            const snapshot = JSON.parse(new TextDecoder().decode(reply.bytes));
            reportSDStage(path, 'delete-unverified-media-snapshot', {
              ioOp: snapshot.ioOp ?? null,
              ioStep: snapshot.ioStep ?? null,
              ioErr: snapshot.ioErr ?? null,
              sdState: snapshot.sdState ?? null,
              sdLiveProbe: snapshot.sdLiveProbe ?? null,
              // recordStage is historical, not evidence of the current delete.
              historicRecordStage: snapshot.recordStage ?? null,
            });
          } catch (_) {
            reportSDStage(path, 'delete-media-snapshot-unavailable');
          }
        }
        reportSDStage(path, 'delete-unverified', { message: error.message });
        throw Error('SD deletion could not be verified. Keep this entry and check SD card before retrying.');
      }
      if (fresh.some((file) => file.path === path)) {
        reportSDStage(path, 'delete-unverified', { reason: 'file-still-listed' });
        throw Error('SD deletion was not verified: this recording is still on the card.');
      }
      // The catalogue call is asynchronous: guard the identity again after
      // its response, before mutating a receipt owned by the original device.
      assertSameConnection();
      localStorage.removeItem(receiptKey(connection.deviceId, path));
      reportSDStage(path, 'delete-verified');
      root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
      return true;
    } finally {
      busy = false;
      renderSDInbox();
    }
  }

  async function discardIncompleteSD(path) {
    if (busy) throw Error('Another SD transfer is already running.');
    const entry = api()?.state?.sdFiles?.find?.((file) => file.path === path),
      bytes = Math.max(0, Number(entry?.bytes) || 0);
    if (!entry) throw Error('This SD file is no longer available.');
    if (entry.syncable !== false && bytes > 44)
      throw Error('This SD recording contains audio. Sync it to Memories instead of deleting it.');
    if (api().state.offline || api().state.session || root.SynapAppControls?.recordingState?.().active)
      throw Error('Stop recording before removing the incomplete SD file.');
    // Reuse the same verified exact-path deletion as the Memories button.
    // Never assume that a successful BLE command removed an SD entry.
    reportSDStage(path, 'delete-incomplete-source', { bytes });
    await deleteSDItem(path);
    return { path, bytes };
  }
  async function describeVisual(visualId, blob, source = 'gemini-offline-voice') {
    if (!visualId || !blob) throw Error('The photo is unavailable for visual inference.');
    const owner = api().state.owner;
    const response = await root.SynapAuth.authedFetch('/v1/chakshu/describe', {
      method: 'POST',
      expectedUid: owner,
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error?.message || 'The photo could not be described.');
    const text = String(data.description || '').trim();
    if (!text) throw Error('The image service returned no description.');
    await api().store.addDescription(visualId, {
      text: text.slice(0, 2000),
      atMs: 0,
      createdAt: new Date().toISOString(),
      source,
    });
    await api().store.patch(visualId, { name: 'What I saw' });
    root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
    root.dispatchEvent(new CustomEvent('synap-visual-library-updated'));
    return text;
  }
  async function describeSavedVisual(visualId) {
    const row = await api().store.get(visualId);
    if (!row || row.kind !== 'image' || row.state !== 'saved')
      throw Error('The synced photo is unavailable for visual inference.');
    const frames = await api().store.frames(visualId),
      blob = new Blob(frames.map((frame) => frame.blob), { type: 'image/jpeg' });
    if (!blob.size) throw Error('The synced photo has no image bytes.');
    return describeVisual(visualId, blob);
  }
    function reportSDStage(path, stage, detail = {}) {
    root.dispatchEvent?.(
      new CustomEvent('synap-sd-sync-diagnostic', {
        detail: { path, stage, ...detail },
      }),
    );
  }

  // Throughput counts only verified contiguous bytes handed to the client.
  // Whole-file speed includes background stalls; live speed uses a 6s window.
  function startSDSpeed(path, notifyProgress = () => {}) {
    const started=Date.now(), samples=[{at:started,bytes:0}];
    let bytes=0,total=0,lastAdvanced=started,lastDraw=0,hiddenAt=null,hiddenMs=0,finished=false;
    const sinks=() => ['librarySDSpeed','deviceSDSpeed'].map((id)=>document.getElementById(id)).filter(Boolean);
    function snapshot() {
      const now=Date.now(),span=Math.max(1,now-started),anchor=samples[0];
      const live=hiddenAt===null && now-lastAdvanced<3000 && now-anchor.at>=250
        ?Math.round((bytes-anchor.bytes)*1000/Math.max(1,now-anchor.at)):0;
      return {bytes,total,percent:total?Math.floor(bytes*100/total):0,
        liveBytesPerSecond:live,averageBytesPerSecond:Math.round(bytes*1000/span),
        elapsedMs:span,hiddenMs:hiddenMs+(hiddenAt===null?0:now-hiddenAt),
        etaSeconds:live?Math.ceil((total-bytes)/live):null,
        background:hiddenAt!==null,stalled:bytes>0&&hiddenAt===null&&now-lastAdvanced>=3000};
    }
    const mb=(n)=>(n/1000000).toFixed(2)+' MB';
    const rate=(n)=>(n/1000).toFixed(1)+' KB/s';
    function render(force=false) {
      if(finished)return;
      const now=Date.now();
      if(!force && now-lastDraw<400)return;
      lastDraw=now;
      const s=snapshot();
      const state=s.background?'Paused by iOS background · open Bluefy':
        s.stalled?'No BLE data arriving · keep Bluefy visible':
        s.liveBytesPerSecond?rate(s.liveBytesPerSecond)+' live':'Measuring live speed';
      const detail=s.total
        ?s.percent+'% · '+mb(s.bytes)+' / '+mb(s.total)+' · '+state+
          ' · '+rate(s.averageBytesPerSecond)+' overall'+
          (s.etaSeconds!==null&&s.percent<100?' · ~'+s.etaSeconds+'s remaining':'')
        :'Preparing BLE download…';
      for(const node of sinks()) {node.hidden=false;node.textContent='BLE SD sync · '+detail;}
      status('Syncing SD audio over Bluetooth · '+detail);
    }
    function onVisibility(){
      const now=Date.now();
      if(document.visibilityState==='hidden')hiddenAt??=now;
      else if(hiddenAt!==null) {
        hiddenMs+=Math.max(0,now-hiddenAt);
        hiddenAt=null;
        samples.splice(0,samples.length,{at:now,bytes});
      }
      render(true);
    }
    document.addEventListener('visibilitychange',onVisibility);
    onVisibility();
    const ticker=root.setInterval(()=>render(),1000);
    return {
      progress(fraction,totalBytes){
        const newTotal=Number(totalBytes);
        if(Number.isFinite(newTotal)&&newTotal>0)total=Math.max(total,newTotal);
        if(total){
          const next=Math.max(bytes,Math.min(total,Math.floor(total*Math.max(0,Math.min(1,Number(fraction)||0)))));
          if(next>bytes){
            bytes=next;lastAdvanced=Date.now();samples.push({at:lastAdvanced,bytes});
            while(samples.length>2&&samples[1].at<lastAdvanced-6000)samples.shift();
          }
        }
        if(Date.now()-lastDraw>=400||fraction>=1){notifyProgress(fraction,totalBytes);render(true);}
      },
      finish(failed=false){
        if(finished)return snapshot();
        const s=snapshot();finished=true;root.clearInterval(ticker);
        document.removeEventListener('visibilitychange',onVisibility);
        for(const node of sinks()){
          node.hidden=false;
          node.textContent=(failed?'BLE sync interrupted · SD original preserved · ':'BLE download complete · ')+
            mb(s.bytes)+' · '+rate(s.averageBytesPerSecond)+' overall'+
            (s.hiddenMs>1000?' · '+Math.round(s.hiddenMs/1000)+'s in background':'');
        }
        reportSDStage(path,'ble-speed-summary',{...s,complete:!failed});
        return s;
      },
    };
  }
  async function moveSD(path, progress = () => {}) {
    if (busy) throw Error('Another device media transfer is already running.');
    const sourceEntry = api()?.state?.sdFiles?.find?.((file) => file.path === path);
    // Old catalogue entries can remain visible after a brownout. Avoid
    // repeatedly issuing doomed SD reads when current C3 status says mount
    // failed; keep the original on SD for explicit recovery/reselection.
    const liveModule = root.SynapModules?.client?.module;
    if (liveModule?.id === 2 && liveModule.sdDetectionState === 2) {
      reportSDStage(path, 'blocked-sd-unavailable', {
        sdLiveProbeState: liveModule.sdLiveProbeState,
      });
      const failedStage = Number(liveModule.sdProbeState);
      throw Error(failedStage >= 40 && ![48, 52, 68].includes(failedStage)
        ? 'C3 SD access is suspended after an offline write/file failure, not confirmed card absence. Preserve the original and fully reset SD power before syncing.'
        : 'C3 SD mount is not ready. Preserve the original recording and check the mounting diagnostics before syncing.');
    }
    if (sourceEntry && (sourceEntry.syncable === false || Number(sourceEntry.bytes) <= 44)) {
      const bytes = Math.max(0, Number(sourceEntry.bytes) || 0);
      reportSDStage(path, 'blocked-incomplete-source', { bytes });
      throw Error(
        bytes
          ? 'This SD recording did not finalize and cannot be synced. It has been kept on the SD card.'
          : 'This SD recording contains no audio bytes and cannot be synced. It has been kept on the SD card.',
      );
    }
    const connection = context(),
      owner = api().state.owner,
      wantsDescribe = Boolean(api().state.sdFiles?.find((file) => file.path === path)?.describe),
      key = receiptKey(connection.deviceId, path);
    let stage = 'receipt-check', speed = null;
    const releaseWake = liveModule?.id === 2
      ? root.SynapAppControls?.beginSDTransferWake?.() : null;
    busy = true;
    renderSDInbox();
    reportSDStage(path, stage);
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (await verifyReceipt(cached)) {
        reportSDStage(path, 'already-synced', { audioId: cached.audioId || null, visualId: cached.visualId || null });
        if (wantsDescribe && cached.visualId && !cached.description) {
          try {
            cached.description = await describeSavedVisual(cached.visualId);
          } catch (error) {
            cached.descriptionError = error.message;
          }
        }
        return { ...cached, alreadySynced: true, keptOnSD: true };
      }
      localStorage.removeItem(key);
      stage = 'download';
      reportSDStage(path, stage);
      speed = startSDSpeed(path,progress);
      const before = await localSnapshot(),
        source = await download(path, undefined, speed.progress);
      speed.finish();
      reportSDStage(path, 'download-complete', { bytes: source.main.size });
      if (sourceEntry?.crc32 !== undefined && isWavPath(path)) {
        stage = 'integrity';
        reportSDStage(path, stage, { expectedCrc32: sourceEntry.crc32 });
        const verifiedCrc32 = await verifyFirmwareCrc(source.main, sourceEntry);
        reportSDStage(path, 'integrity-complete', { crc32: verifiedCrc32 });
      }
      const mainSha = await digest(source.main);
      if (owner !== api().state.owner || connection !== root.SynapDevices?.connection)
        throw Error('Account or pendant changed during transfer. The SD original was kept.');
      stage = 'import';
      reportSDStage(path, stage, { files: source.files.length });
      await api().importFiles(source.files, connection.deviceId);
      reportSDStage(path, 'import-complete');
      const rows = await api().store.list(),
        journal = audioJournal(),
        recordings = await journal.all('recordings');
      let visualId = null,
        audioId = null,
        verifiedAudio = null;
      stage = 'verify';
      reportSDStage(path, stage);
      if (/\.(jpg|mjpeg)$/i.test(path)) {
        const row = rows
          .filter((item) => !before.visuals.has(item.id) && item.sourceName === basename(path))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        if (!row) throw Error('The imported visual could not be verified. The SD original was kept.');
        const verifiedVisual = await verifyVisual(row.id, source.main, source.wav);
        verifiedAudio = verifiedVisual.verifiedAudio;
        visualId = row.id;
        audioId = row.audioId || null;
      } else if (isWavPath(path)) {
        const record = recordings
          .filter((item) => !before.recordings.has(item.id) && item.ownerUid === owner)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        if (!record) throw Error('The imported audio could not be verified. The SD original was kept.');
        verifiedAudio = await verifyAudio(record.id, source.main);
        audioId = record.id;
      } else throw Error('Move the primary photo, video or audio file instead.');
      const receipt = {
        schema: 1,
        owner,
        deviceId: connection.deviceId,
        path,
        visualId,
        audioId,
        mainBytes: source.main.size,
        ...(sourceEntry?.crc32 !== undefined ? { sourceCrc32: sourceEntry.crc32 } : {}),
        ...(sourceEntry?.take ? { take: sourceEntry.take, part: sourceEntry.part ?? null } : {}),
        mainSha256: mainSha,
        ...(verifiedAudio
          ? { audioBytes: verifiedAudio.bytes, audioSha256: verifiedAudio.sha256 }
          : {}),
        describeRequested: wantsDescribe,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(key, JSON.stringify(receipt));
      reportSDStage(path, 'verify-complete', { audioId, visualId });
      reportSDStage(path, 'complete', { audioId, visualId, keptOnSD: true });
      const sdAvailableAfterSync = liveModule?.id === 2
        ? await reportC3PostSync(path, connection) : null;
      root.dispatchEvent(new CustomEvent('synap-chakshu-changed'));
      // Verification completes the sync transaction. The SD original is kept
      // until the user explicitly chooses Delete from SD. Cloud inference is
      // independent of that retention choice; Memories stays durable either way.
      if (wantsDescribe && visualId) {
        try {
          receipt.description = await describeVisual(visualId, source.main);
        } catch (error) {
          receipt.descriptionError = error.message;
        }
      }
      return { ...receipt, alreadySynced: false, keptOnSD: true, sdAvailableAfterSync };
    } catch (error) {
      speed?.finish(true);
      reportSDStage(path, 'failed', { failedAt: stage, message: error?.message || String(error) });
      if (liveModule?.id === 2) await reportC3SyncTrace(path, connection, 'failed-' + stage);
      throw error;
    } finally {
      releaseWake?.();
      busy = false;
      renderSDInbox();
    }
  }
  async function clearSD() {
    if (c3MaintenanceWritesBlocked()) throw Error(C3_SD_WRITE_SAFETY_MESSAGE);
    if (busy) throw Error('Another SD transfer is already running.');
    const connection = context();
    if (api().state.offline || api().state.session || root.SynapAppControls.recordingState().active)
      throw Error('Stop recording before clearing the SD card.');
    busy = true;
    try {
      const reply = await client().request(18);
      // C3 firmware currently deletes at most 100 files per clear. Never
      // discard every verified local receipt: undeleted SD originals must
      // remain marked as synced and must not be imported twice on reconnect.
      // Old receipts for deleted unique paths are harmless and can be removed
      // individually through Delete from SD. Refresh observationally; do not
      // force an unnecessary SD unmount/remount (media op 14) after clearing.
      try {
        await api().catalogue();
      } catch (error) {
        reportSDStage('@all', 'clear-catalogue-unavailable', {
          removed: reply.total || 0,
          message: error?.message || String(error),
        });
      }
      return reply.total || 0;
    } finally {
      busy = false;
    }
  }
  async function diagnoseC3SdReadOnly() {
    if (busy) throw Error('Finish the current SD operation before diagnosing storage.');
    const connection = context();
    const module = root.SynapModules?.client?.module;
    if (module?.id !== 2) throw Error('Raw SD diagnosis is available only for Odyssey C3.');
    if (api().state.storageReady || module.sdDetectionState === 1)
      throw Error('SD is mounted; raw diagnostics are disabled to avoid interfering with existing recordings.');
    if (api().state.offline || api().state.session ||
        root.SynapAppControls?.recordingState?.().active)
      throw Error('Stop recording before diagnosing the SD controller.');
    busy = true;
    renderSDInbox();
    try {
      // RAM op29 precedes a raw-sector probe. CMD24/25 timeout means the
      // SD rail can still be busy; don't issue more card commands.
      let trace=null;
      try {
        const reply=await client().request(29);
        trace=JSON.parse(new TextDecoder().decode(reply.bytes));
      } catch (_) { /* Legacy firmware: keep the existing guarded op28. */ }
      if (root.SynapDevices?.connection !== connection)
        throw Error('Pendant changed during diagnosis. Reconnect.');
      if (trace?.version===1 && trace.sdState===2 && trace.wireErr===263 &&
          (trace.wireCmd===24 || trace.wireCmd===25)) {
        const message='SD controller unavailable after CMD'+trace.wireCmd+
          ' timeout ('+String(trace.wireMs)+' ms, sector '+
          String(trace.wireArg)+'). No raw-sector read was attempted. '+
          'Preserve SD originals and power-cycle the SD supply before testing.';
        reportSDStage('@all','raw-sector0-skipped-write-timeout',
          {readOnly:true,wireCmd:trace.wireCmd,wireArg:trace.wireArg});
        return {status:null,error:null,skipped:true,message};
      }
      reportSDStage('@all', 'raw-sector0-requested', { readOnly: true });
      // Firmware media op28 initializes a temporary SDSPI session and reads
      // LBA0 and (for v2) one bounds-checked FAT VBR read, once per boot.
      const reply = await client().request(28);
      if (root.SynapDevices?.connection !== connection)
        throw Error('Bluetooth changed during the SD diagnostic. Reconnect before repeating.');
      const data = JSON.parse(new TextDecoder().decode(reply.bytes));
      if (!data || ![1, 2].includes(data.version) || !Number.isInteger(data.status) ||
          data.status < 0 || data.status > 8)
        throw Error('Firmware returned an invalid SD diagnostic result.');
      const fields = ['status', 'error', 'sectors', 'sectorBytes', 'signature',
        'fatHint', 'partitionLba', 'mountErr', 'firstMountErr', 'sdState', 'sdProbe',
        'partitionType', 'partitionIndex', 'partitionSectors', 'partitionBounds',
        'vbrRead', 'vbrError', 'vbrSignature', 'bpbPlausible', 'fatVariant',
        'bpbBytesPerSector', 'bpbSectorsPerCluster', 'bpbTotalSectors'];
      const snapshot = Object.fromEntries(fields.map((field) => [field, data[field] ?? null]));
      reportSDStage('@all', 'raw-sector0-result', { readOnly: true, ...snapshot });
      const summary = {
        0: 'No raw SD test completed.',
        1: 'Raw SD sector 0 is readable. A FAT filesystem mount and the contents of previous recordings remain unverified.',
        2: 'Raw-sector diagnosis refused: the SD driver may still own the SPI bus after a failed write. No sectors were read; zero FAT fields are not evidence of corruption.',
        3: 'SD controller appears stuck busy. SPI recovery may require a true SD power cycle.',
        4: 'SD SPI bus setup or cleanup failed.',
        5: 'SD host initialization failed.',
        6: 'SD SPI device initialization failed.',
        7: 'SD card initialization failed before FAT could be checked.',
        8: 'SD initialized but the raw sector-0 read failed.',
      }[data.status];
      // A valid BPB only establishes boot-sector plausibility; it does not
      // establish FAT table integrity or that deleted recordings survived.
      let partitionSummary = '';
      if (data.version === 2 && data.status === 1) {
        if (data.fatHint !== 2 || data.partitionBounds !== 1) {
          partitionSummary = ' No bounded FAT partition was identified in the MBR.';
        } else if (data.vbrRead === 2) {
          partitionSummary = ' The FAT partition boot sector could not be read (error ' +
            String(data.vbrError ?? '?') + ').';
        } else if (data.vbrRead === 1 && data.vbrSignature !== 1) {
          partitionSummary = ' The partition boot sector is readable but its 0x55AA signature is absent.';
        } else if (data.vbrRead === 1 && data.bpbPlausible !== 1) {
          partitionSummary = ' The partition boot sector is readable but its FAT parameters are inconsistent.';
        } else if (data.vbrRead === 1 && data.bpbPlausible === 1) {
          partitionSummary = ' The FAT' + String(data.fatVariant) +
            ' boot parameters look internally consistent. FAT tables and recordings remain unverified.';
        } else {
          partitionSummary = ' The partition boot sector was not checked.';
        }
      }
      const message = 'Read-only SD result: ' + summary + partitionSummary +
        ' Status=' + data.status + ', error=' + String(data.error ?? '?') +
        ', firstMountErr=' + String(data.firstMountErr ?? '?') +
        ', FAT hint=' + String(data.fatHint ?? '?') +
        (data.version === 2
          ? ', partitionLba=' + String(data.partitionLba ?? '?') +
            ', partitionType=' + String(data.partitionType ?? '?') +
            ', partitionSectors=' + String(data.partitionSectors ?? '?') +
            ', VBR=' + String(data.vbrRead ?? '?') +
            ', VBR error=' + String(data.vbrError ?? '?') +
            ', BPB plausible=' + String(data.bpbPlausible ?? '?')
          : '') +
        (data.status===2
          ? '. No repair, format or raw-sector read occurred. Error 259 means an invalid driver state, not a FAT failure. Restarting the MCU does not necessarily power-cycle the SD card.'
          : '. No repair or format occurred. The firmware caches a completed raw-sector attempt for this MCU boot; a genuine SD power cycle may also be required.');
      return { ...snapshot, message };
    } catch (error) {
      reportSDStage('@all', 'raw-sector0-failed', { message: error?.message || String(error) });
      if (error?.mediaCode === 2)
        throw Error('The connected firmware does not support read-only SD diagnosis yet. Update Odyssey C3 firmware first; do not format this card.');
      throw error;
    } finally {
      busy = false;
      renderSDInbox();
    }
  }

  // FAT capacity is fetched by an explicit button, never between BLE sync
  // packets or while the offline recorder owns the storage mutex.
  let sdCapacitySnapshot=null, sdCapacityDeviceId='';
  const sdBytesLabel=bytes => (Number(bytes)/(1024*1024*1024)).toFixed(2)+' GiB';
  async function checkSDCapacity() {
    if (busy || api()?.state?.working) throw Error('Finish the current SD transfer first.');
    const connection=context();
    if (root.SynapModules?.client?.module?.id !== 2)
      throw Error('SD capacity is supported on Synap Odyssey C3.');
    if (!api().state.storageReady)
      throw Error('SD unavailable. Recover SD before checking its capacity.');
    if (root.SynapAppControls?.recordingState?.().active)
      throw Error('Stop recording before checking SD capacity.');
    busy=true;
    renderSDInbox();
    try {
      const reply=await client().request(32);
      if (root.SynapDevices?.connection !== connection)
        throw Error('Bluetooth connection changed while reading capacity.');
      const data=JSON.parse(new TextDecoder().decode(reply.bytes));
      if (data?.version!==1 ||
          ![data.totalBytes,data.freeBytes,data.physicalBytes].every(
            value=>Number.isSafeInteger(value)&&value>=0) ||
          !data.totalBytes || data.freeBytes>data.totalBytes)
        throw Error('Invalid SD capacity data from the pendant.');
      sdCapacityDeviceId=connection.deviceId;
      sdCapacitySnapshot=data;
      reportSDStage('@all','sd-capacity-readonly',{
        totalBytes:data.totalBytes,freeBytes:data.freeBytes,physicalBytes:data.physicalBytes,
      });
      return data;
    } catch(error) {
      sdCapacityDeviceId='';
      sdCapacitySnapshot=null;
      throw error;
    } finally {
      busy=false;
      renderSDInbox();
    }
  }
  // Emergency provisioning is NEVER automatic: it may erase ALL files. It
  // is only usable when a freshly power-cycled SD card responds over SPI but
  // the FAT volume fails to mount. A timed-out CMD24/25 on the current SD
  // power rail still requires a real electrical power cycle first.
  async function emergencyFormatSD() {
    if (busy || api()?.state?.working)
      throw Error('Finish all recording and SD transfers before emergency recovery.');
    const connection=context();
    const info=root.SynapModules?.client?.module;
    if (info?.id!==2 || api().state.storageReady || info?.sdDetectionState!==2 ||
        Number(info?.sdLiveProbeState)!==3)
      throw Error('Emergency format is available only after a cold boot with an SD FAT mount failure. Do not format a card with a live write timeout.');
    if (api().state.offline || api().state.session ||
        root.SynapAppControls?.recordingState?.().active)
      throw Error('Stop recording before emergency recovery.');
    busy=true;
    renderSDInbox();
    try {
      await root.SynapPowerLifecycle?.wakeForActivity?.();
      status('Emergency SD FAT recovery requested. Never disconnect power during this operation.');
      try {
        await client().request(33,0x53445246); // SDRF, one-shot destructive token
      } catch(error) {
        reportSDStage('@all','emergency-fat-rescue-not-verified',{
          message:error?.message || String(error),
          mediaCode:error?.mediaCode ?? null,
        });
        throw Error('Emergency recovery refused or unverified. Do not repeat Format. Fully power off the pendant and SD supply, then examine the card. Firmware build may need updating. Detail: '+error.message);
      }
      await new Promise(resolve=>root.setTimeout(resolve,6000));
      await root.SynapModules?.refresh?.();
      if(root.SynapDevices?.connection!==connection)
        throw Error('Bluetooth changed after emergency recovery. Do not retry formatting; reconnect to inspect.');
      const live=root.SynapModules?.client?.module;
      if(live?.sdDetectionState!==1 || live?.sdLiveProbeState!==6)
        throw Error('Emergency recovery result not verified. Do not retry Format.');
      // A successful mount need not mean the helper actually formatted; it
      // may have re-mounted the original FAT. Preserve existing sync receipts.
      const found=await api().catalogue();
      status('SD filesystem available after emergency recovery · '+found.length+
        ' Synap files visible. Browse and check capacity before recording.');
      return found;
    } finally {
      busy=false;
      renderSDInbox();
    }
  }
  async function formatSD() {
    if (C3_FULL_CARD_FORMAT_DISABLED)
      throw Error('This firmware does not support safe SD formatting.');
    if (busy) throw Error('Another SD transfer is already running.');
    const connection = context();
    if (!c3FormatSupported()) throw Error('Update Odyssey C3 firmware to format its SD card.');
    if (!api().state.storageReady)
      throw Error('SD card unavailable. Do not attempt another format on a failed or unmounted card.');
    if (c3FormatUnsafe())
      throw Error('SD format disabled: this Odyssey C3 retains an SD recording write timeout. Preserve existing files; full-card formatting is unsafe until SD write reliability is fixed.');
    if (api().state.offline || api().state.session || root.SynapAppControls.recordingState().active)
      throw Error('Stop recording before formatting the SD card.');
    // Preflight media op32 is read-only and only exists on firmware with the
    // token-bound formatter. An older C3 must never receive format opcode19.
    await checkSDCapacity();
    // A synced WAV remains on the card by design. The confirmation dialog
    // still warns that formatting erases ALL files, including non-Synap files.
    busy = true;
    renderSDInbox();
    try {
      status('Formatting SD card…');
      try {
        await client().request(19, 0x5344464d); // SDFM: destructive-format confirmation token
      } catch (error) {
        // Native ESP-IDF format unmounts FAT before f_mkfs. If f_mkfs
        // returns an error, FAT may be partially overwritten and unmounted.
        // Query only media operation 27 (RAM/NVS); NEVER auto-remount,
        // re-format, clear, or discard original sync receipts.
        reportSDStage('@all', 'format-failed', {
          message: error?.message || String(error),
          mediaCode: error?.mediaCode ?? null,
        });
        try {
          const reply = await client().request(27);
          const snapshot = JSON.parse(new TextDecoder().decode(reply.bytes));
          reportSDStage('@all', 'format-failed-media-snapshot', {
            ioOp: snapshot.ioOp ?? null,
            ioStep: snapshot.ioStep ?? null,
            ioErr: snapshot.ioErr ?? null,
            sdState: snapshot.sdState ?? null,
            sdLiveProbe: snapshot.sdLiveProbe ?? null,
            historicRecordStage: snapshot.recordStage ?? null,
          });
        } catch (_) {
          reportSDStage('@all', 'format-media-snapshot-unavailable');
        }
        throw Error('SD format failed or its result is uncertain. FAT may be partially modified. Do NOT retry Format or Clear SD. Fully power off the device, then reconnect and inspect SD without writing.');
      }
      // The ESP-IDF format helper already remounts FAT on success.
      // An automatic operation 14 here would unmount/remount the card
      // again needlessly, potentially leaving a busy controller stranded.
      // Settle, then verify the FAT catalogue without another write.
      await new Promise((resolve) => root.setTimeout(resolve, 6000));
      const files = await api().catalogue();
      await root.SynapModules?.refresh?.();
      const info = root.SynapModules?.client?.module;
      if (info?.sdDetectionState !== 1 || info?.sdLiveProbeState !== 6 || files.length !== 0)
        throw Error('SD format result could not be verified. Existing sync receipts were preserved; do not retry formatting.');
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key?.startsWith(RECEIPT_PREFIX + connection.deviceId + ':')) localStorage.removeItem(key);
      }
      status('SD card formatted · FAT storage is ready.');
      await api().syncPendingSD().catch(() => {});
      return true;
    } finally {
      busy = false;
      renderSDInbox();
    }
  }
  async function startOffline(profile = 0, seconds = 10) {
    void profile; void seconds;
    throw Error('Offline SD capture is device-owned and runs only while Chakshu is disconnected from the PWA.');
  }

  async function startOfflineAudio(seconds = 600) {
    void seconds;
    throw Error('Offline SD capture is device-owned and runs only while Chakshu is disconnected from the PWA.');
  }

  async function describeNow() {
    if (busy || api().state.busy) throw Error('Finish the current capture or transfer first.');
    const connection = context(),
      owner = api().state.owner;
    if (!api().state.storageReady) throw Error('Insert an SD card to keep the full-quality photo.');
    busy = true;
    try {
      const transfer = new root.SynapChakshuTransfer.Client(connection),
        saved = await transfer.savedPreview();
      const receipt = await (async () => {
        busy = false;
        try {
          return await moveSD(saved.path);
        } finally {
          busy = true;
        }
      })();
      if (!receipt.visualId) throw Error('The photo was not saved in Memory.');
      if (owner !== api().state.owner) throw Error('Account changed before visual inference.');
      const text = await describeVisual(receipt.visualId, saved.blob, 'gemini-explicit');
      return { id: receipt.visualId, description: text };
    } finally {
      busy = false;
    }
  }
  function renderSDRows(list, files) {
    if (!list) return;
    list.replaceChildren();
    if (!files.length) {
      list.textContent = 'No Synap captures on the SD card.';
      return;
    }
    for (const file of files) {
      const row = document.createElement('div'),
        label = document.createElement('span'),
        action = document.createElement('button'),
        remove = document.createElement('button'),
        name = basename(file.path),
        type = file.describe
          ? 'Explain photo on SD'
          : isWavPath(file.path)
            ? 'Audio on SD'
            : isMjpegPath(file.path)
              ? 'Video on SD'
              : 'Photo on SD',
        incomplete = file.syncable === false || Number(file.bytes) <= 44,
        synced = !incomplete && isSDSynced(file.path);
      row.className = 'visual-sd-row';
      label.textContent =
        type + ' · ' + name + ' · ' + Math.max(1, Math.round((file.bytes || 0) / 1024)) + ' KB' +
        (synced ? ' · Synced to Memories' : incomplete ? ' · Incomplete' : ' · Not synced');
      action.type = 'button';
      action.textContent = incomplete ? 'Cannot sync' : synced ? 'Synced to Memories' : 'Sync to Memories';
      action.disabled = incomplete || synced;
      if (!action.disabled) {
        action.addEventListener('click', async () => {
          action.disabled = true;
          try {
            const result = await moveSD(file.path, (fraction) =>
              status('Syncing to Memories over Bluetooth · ' + Math.round(fraction * 100) + '%'),
            );
            if (root.SynapModules?.client?.module?.id === 2) {
              // No post-sync FAT reads or unlink on C3. The source survives
              // until a separately requested Delete from SD.
              status(result?.sdAvailableAfterSync === false
                ? 'Recording saved in Memories, but C3 SD became unavailable during sync. Do not retry, delete, or format SD; inspect read-only diagnostics.'
                : type.replace(' on SD', '') +
                  ' synced to Memories · SD original kept. Browse SD separately after verifying the recording.');
            } else {
              const deleteNow = confirm(
                'Synced to Memories successfully. Delete this recording from the device SD card now? The copy in Memories will be kept.',
              );
              if (deleteNow) {
                await deleteSDItem(file.path);
                status(type.replace(' on SD', '') + ' synced to Memories · SD copy deleted.');
              } else {
                status(type.replace(' on SD', '') + ' synced to Memories · SD copy kept.');
              }
            }
          } catch (error) {
            status(error.message);
          } finally {
            action.disabled = false;
            if (root.SynapModules?.client?.module?.id !== 2)
              await browseSD(list.id).catch(() => {});
            renderSDInbox();
          }
        });
      }
      remove.type = 'button';
      const c3DeletePaused = root.SynapModules?.client?.module?.id === 2;
      remove.textContent = c3DeletePaused ? 'SD delete paused' : 'Delete from SD';
      remove.disabled = c3DeletePaused || !api().state.storageReady || busy;
      remove.title = c3DeletePaused
        ? 'C3 FAT unlink failed after verified sync. Preserve SD files; use a card reader after backup.'
        : remove.disabled
          ? 'SD access is not ready. Preserve WAVs and never delete during write/read quarantine.'
          : 'Permanently delete this selected SD file after explicit confirmation';
      remove.addEventListener('click', async () => {
        const warning = synced
          ? 'Delete this SD copy? The synced copy in Memories will be kept.'
          : incomplete
            ? 'Delete this incomplete recording from the SD card? This cannot be undone.'
            : 'Delete this recording from the SD card without syncing it to Memories? This cannot be undone.';
        if (!confirm(warning)) return;
        if (!synced && !incomplete && root.SynapModules?.client?.module?.id === 2 &&
            !confirm('This recording is NOT synced to Memories. Deleting it permanently loses its audio. Delete this SD file anyway?')) return;
        remove.disabled = true;
        try {
          await deleteSDItem(file.path);
          status(synced ? 'SD copy deleted. Memory kept.' : 'Recording deleted from SD.');
          await browseSD(list.id);
        } catch (error) {
          status(error.message);
        } finally {
          remove.disabled = false;
          renderSDInbox();
        }
      });
      row.append(label, action, remove);
      list.append(row);
    }
  }
  async function browseSD(listId = 'visualSDList') {
    const list = document.getElementById(listId);
    if (!list) return [];
    list.hidden = false;
    list.replaceChildren();
    list.textContent = 'Checking pendant SD…';
    const files = await api().catalogue();
    renderSDRows(list, files);
    renderSDInbox();
    return files;
  }
  function renderSDInbox() {
    const state = api()?.state || {},
      panel = document.getElementById('librarySDInbox'),
      toggle = document.getElementById('libraryStorageInfoToggle'),
      text = document.getElementById('librarySDInboxText'),
      check = document.getElementById('libraryCheckSD'),
      browse = document.getElementById('libraryBrowseSD'),
      sync = document.getElementById('librarySyncSD'),
      list = document.getElementById('librarySDList'),
      sdFiles = state.sdFiles || [],
      count = sdFiles.length,
      unsyncedCount = sdFiles.filter(
        (file) => file.syncable !== false && Number(file.bytes) > 44 && !isSDSynced(file.path),
      ).length,
      deviceId = root.SynapDevices?.connection?.deviceId || state.sdFilesDeviceId || state.devices?.[0]?.deviceId || '',
      last = root.SynapChakshuVoice?.lastOutcome?.(deviceId),
      outcome = last?.message ? String(last.message).replace(/Chakshu SD/g, 'device storage').replace(/Chakshu/g, 'device') : '',
      suffix = outcome ? ' Last offline result: ' + outcome : '',
      blocked = busy || state.working || state.offline || Boolean(state.session),
      settings = document.getElementById('deviceSDSettings'),
      settingsStatus = document.getElementById('deviceSDSettingsStatus'),
      retrySettings = document.getElementById('retryDeviceSD'),
      capacitySettings = document.getElementById('checkDeviceSDCapacity'),
      capacityText = document.getElementById('deviceSDCapacity'),
      clearSettings = document.getElementById('clearDeviceSD'),
      formatSettings = document.getElementById('formatDeviceSD'),
      emergencySettings = document.getElementById('emergencyFormatDeviceSD'),
      rawProbeSettings = document.getElementById('diagnoseDeviceSD'),
      ramProbeSettings = document.getElementById('diagnoseDeviceSDRam'),
      recorderProbeSettings = document.getElementById('diagnoseDeviceSDRecorder'),
      wifiSettings = document.getElementById('deviceWifiSettings'),
      wifiSettingsStatus = document.getElementById('deviceWifiSettingsStatus'),
      wifiSave = document.getElementById('startDeviceAp'),
      wifiForget = document.getElementById('stopDeviceAp'),
      info = root.SynapModules?.client?.module,
      // Keep the handoff panel available after BLE drops: its credentials
      // were authenticated on the original connection before Wi-Fi started.
      supportsC3Wifi = false, // Odyssey C3 Wi-Fi removed; Chakshu unchanged.
      supportsC3Format = Boolean(info?.id === 2 && (info?.mediaFeatures & 4)),
      supportsStorage =
        Boolean(info) &&
        root.SynapCapabilities?.hasMedia?.(info) &&
        root.SynapCapabilities?.supports?.(info, 'sd');
    if (settings) settings.hidden = !supportsStorage;
    if (settingsStatus && supportsStorage)
      settingsStatus.textContent = !state.connected
        ? 'Connect the pendant to manage its SD card.'
        : busy
          ? 'SD transfer in progress · SD maintenance controls are temporarily disabled.'
          : state.storageReady
            ? count
              ? count + ' item' + (count === 1 ? '' : 's') + ' on SD · ' + unsyncedCount + ' waiting to sync.'
              : 'SD card ready · no captures on SD.'
            : info?.id === 2 && info?.sdLiveProbeState === 1
            ? 'SD SPI bus setup failed.'
            : info?.id === 2 && info?.sdLiveProbeState === 2
              ? 'SD card protocol initialization failed.'
              : info?.id === 2 && info?.sdLiveProbeState === 3
                ? 'SD FAT mount or format failed. The filesystem may be incomplete; do not repeat Format.'
                : info?.id === 2 && info?.sdLiveProbeState === 4
                  ? 'SD filesystem mounted, but VFS validation failed.'
                  : info?.id === 2 && info?.sdDetectionState === 2 &&
                    Number(info?.sdProbeState) >= 40 &&
                    ![48, 52, 68].includes(Number(info?.sdProbeState))
                  ? 'SD access suspended after recording write/file fault. Card not confirmed absent. Fully power-cycle SD and validate mount to resume normal use; keep original recordings.'
                  : 'SD mount not ready. Check the card diagnostics without erasing recordings.';
    if (capacityText) {
      const capacityReady=state.connected && state.storageReady &&
        sdCapacityDeviceId===deviceId && sdCapacitySnapshot;
      capacityText.textContent=capacityReady
        ? 'SD FAT capacity '+sdBytesLabel(sdCapacitySnapshot.totalBytes)+
          ' · Used '+sdBytesLabel(sdCapacitySnapshot.totalBytes-sdCapacitySnapshot.freeBytes)+
          ' · Free '+sdBytesLabel(sdCapacitySnapshot.freeBytes)+
          ' · Card '+sdBytesLabel(sdCapacitySnapshot.physicalBytes)
        : 'SD capacity: '+(!state.connected?'connect the pendant':
            !state.storageReady?'unavailable; use Recover SD first':'select Check capacity');
    }
    if (capacitySettings) {
      capacitySettings.hidden=info?.id!==2;
      capacitySettings.disabled=blocked || !state.connected || !state.storageReady ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
    }
    if (retrySettings)
      retrySettings.disabled =
        !supportsStorage ||
        blocked ||
        !state.connected ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
    if (clearSettings) {
      clearSettings.disabled =
        c3MaintenanceWritesBlocked() ||
        !supportsStorage ||
        blocked ||
        !state.connected ||
        !state.storageReady ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
      clearSettings.title = c3MaintenanceWritesBlocked() ? C3_SD_WRITE_SAFETY_MESSAGE : 'Remove Synap recordings from SD';
    }
    if (recorderProbeSettings) {
      recorderProbeSettings.hidden = info?.id !== 2;
      recorderProbeSettings.disabled = info?.id !== 2 || blocked || !state.connected ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
      recorderProbeSettings.title='Read the last recorder fault from ESP RAM/NVS without accessing the SD card.';
    }
    if (ramProbeSettings) {
      ramProbeSettings.hidden = info?.id !== 2;
      ramProbeSettings.disabled = info?.id !== 2 || blocked || !state.connected ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
      ramProbeSettings.title = 'Read only firmware RAM counters (media op29); no SD card access and works while FAT is unavailable.';
    }
    if (rawProbeSettings) {
      rawProbeSettings.hidden = info?.id !== 2;
      // No FAT read is required. Present this only while the SD is unavailable.
      rawProbeSettings.disabled =
        info?.id !== 2 ||
        blocked ||
        !state.connected ||
        state.storageReady ||
        info?.sdDetectionState === 1 ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
      rawProbeSettings.title = 'Read up to two diagnostic sectors once per pendant boot; subsequent taps show the cached result. Never formats or repairs SD.';
    }
    if (emergencySettings) {
      const fatMountFailed = supportsStorage && info?.id===2 && state.connected &&
        !state.storageReady && info?.sdDetectionState===2 &&
        Number(info?.sdLiveProbeState)===3;
      emergencySettings.hidden = !supportsStorage || info?.id!==2 || state.storageReady;
      emergencySettings.disabled = !fatMountFailed || blocked ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
      emergencySettings.title = fatMountFailed
        ? 'DESTRUCTIVE LAST RESORT: a cold-booted card initialized but FAT failed. May erase ALL files.'
        : 'Only after a full power cycle and FAT mount failure. Live SD controller timeout requires electrical SD power removal; this is NOT a reset button.';
    }
    if (formatSettings) {
      formatSettings.hidden = !supportsC3Format;
      formatSettings.disabled =
        C3_FULL_CARD_FORMAT_DISABLED ||
        !supportsC3Format ||
        blocked ||
        !state.connected ||
        !state.storageReady ||
        c3FormatUnsafe() ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
      formatSettings.textContent = C3_FULL_CARD_FORMAT_DISABLED ? 'Format SD (disabled)' : 'Format SD Card';
      formatSettings.title = C3_FULL_CARD_FORMAT_DISABLED
        ? 'On-device formatting unavailable. Power off and format on a computer after backup.'
        : c3FormatUnsafe()
        ? 'Formatting disabled: recorded SD write fault. Preserve the card until the firmware write path is qualified.'
        : !state.storageReady
          ? 'Formatting unavailable: card is not mounted and healthy.'
          : 'Permanently erase all SD files.';
    }
    if (wifiSettings) wifiSettings.hidden = !supportsC3Wifi;
    if (wifiSave)
      wifiSave.disabled =
        !supportsC3Wifi ||
        blocked ||
        !state.connected ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
    if (wifiForget)
      wifiForget.disabled =
        !supportsC3Wifi ||
        blocked ||
        !state.connected ||
        Boolean(root.SynapAppControls?.recordingState?.().active);
    if (wifiSettingsStatus && supportsC3Wifi && !state.connected)
      wifiSettingsStatus.textContent = c3BridgeAp?.active
        ? 'Private pendant Wi-Fi handoff · Bluetooth may disconnect on ESP32-C3. Join '+
          c3BridgeAp.ssid+' in iPhone Wi-Fi Settings, return to this Synap tab, and open the private page.'
        : 'Connect Odyssey C3 to start private SD downloads.';
    if (!panel) return;
    if (toggle) {
      toggle.hidden = !state.available;
      if (!state.available) toggle.setAttribute('aria-expanded', 'false');
    }
    const open = Boolean(toggle && toggle.getAttribute('aria-expanded') === 'true');
    panel.hidden = !state.available || !open;
    if (panel.hidden) return;
    if (text) {
      if (!state.connected)
        text.textContent = 'Connect a device to review or sync content saved offline. Photos, videos and audio remain safely stored locally until sync.' + suffix;
      else if (!state.storageReady)
        text.textContent = 'Device connected · local storage unavailable. Check the device storage and try again.' + suffix;
      else
        text.textContent = (count
          ? count + ' item' + (count === 1 ? '' : 's') + ' on SD · ' + unsyncedCount + ' waiting to sync. Synced SD copies stay visible until you choose Delete from SD.'
          : 'Device storage ready · no captures on SD.') + suffix;
    }
    if (check) check.disabled = blocked || !state.connected || !state.mediaSupported;
    if (browse) browse.disabled = blocked || !state.connected || !state.storageReady;
    if (sync) sync.disabled = blocked || !state.connected || !state.storageReady || unsyncedCount === 0;
    if (list && (!state.connected || !state.storageReady)) list.hidden = true;
    else if (list && !list.hidden) renderSDRows(list, state.sdFiles || []);
  }
  async function reportC3SyncTrace(path, connection, phase) {
    if (root.SynapModules?.client?.module?.id !== 2 ||
        root.SynapDevices?.connection !== connection) return null;
    try {
      // Firmware op29 reports RAM-only counters: no FAT, file, raw sector,
      // remount, format or delete, even when the SD controller is unavailable.
      const reply = await client().request(29);
      if (root.SynapDevices?.connection !== connection) return null;
      const trace = JSON.parse(new TextDecoder().decode(reply.bytes));
      if (trace?.version !== 1) throw Error('Invalid C3 sync trace response.');
      const fields = ['sdState','sdLiveProbe','ioOp','ioStep','ioErr',
        'reads','cacheHits','diskFills','lastRequestedOffset','lastOkOffset',
        'faultOffset','windowRequests','mtuFallbacks','wireCmd','wireErr','wireArg','wireMs',
        'readGot','readWant','readFlags'];
      const detail = Object.fromEntries(fields.map((name) => [name, trace[name] ?? null]));
      reportSDStage(path, 'c3-sync-read-trace', { phase, ...detail });
      return detail;
    } catch (error) {
      // Older firmware does not implement op29. Observability can never turn
      // an otherwise verified Memories import into an apparent sync failure.
      reportSDStage(path, 'c3-sync-read-trace-unavailable', {
        phase, mediaCode: error?.mediaCode ?? null,
        message: error?.message || String(error),
      });
      return null;
    }
  }
  // Available even when FAT is unmounted. Op29 reads only firmware RAM;
  // unlike raw op28 it never creates an SDSPI session or requests sectors.
  async function diagnoseC3SdWireReadOnly() {
    if (busy) throw Error('Finish the active SD operation before reading controller diagnostics.');
    const connection = context();
    if (root.SynapModules?.client?.module?.id !== 2)
      throw Error('SD controller diagnostics are available only for Odyssey C3.');
    if (api().state.offline || api().state.session ||
        root.SynapAppControls?.recordingState?.().active)
      throw Error('Stop recording before reading SD controller diagnostics.');
    busy = true;
    renderSDInbox();
    try {
      const reply = await client().request(29);
      if (root.SynapDevices?.connection !== connection)
        throw Error('Pendant disconnected during diagnostics. Reconnect and read again.');
      const result = JSON.parse(new TextDecoder().decode(reply.bytes));
      if (result?.version !== 1 || !Number.isInteger(result?.sdState))
        throw Error('Invalid firmware SD RAM snapshot.');
      const fields = ['sdState','sdLiveProbe','ioOp','ioStep','ioErr','reads',
        'cacheHits','diskFills','faultOffset','wireCmd','wireErr','wireArg','wireMs',
        'readGot','readWant','readFlags'];
      const detail = Object.fromEntries(fields.map((field) => [field,result[field] ?? null]));
      reportSDStage('@all','c3-controller-ram-snapshot',{readOnly:true,...detail});
      const hasWireFields = Number.isInteger(result.wireCmd);
      const hasWireFault = hasWireFields && result.wireCmd !== 4294967295;
      const nativeFault = !hasWireFields
        ? ' Native SD command diagnostics are unavailable in this firmware; update to build 2091 or later.'
        : hasWireFault
          ? ' First SDSPI command failure: CMD' + result.wireCmd +
            ', ESP error ' + String(result.wireErr ?? '?') +
            ', sector argument ' + String(result.wireArg ?? '?') +
            ', elapsed ' + String(result.wireMs ?? '?') + ' ms.'
          : ' No native SD command failure captured in this boot.';
      return 'C3 SD RAM diagnosis: state=' + detail.sdState +
        ', probe=' + detail.sdLiveProbe +
        ', media op=' + detail.ioOp +
        ', step=' + detail.ioStep +
        ', errno=' + detail.ioErr + '.' + nativeFault +
        ' Read only; no SD sectors, remount, delete, or format were requested.';
    } catch (error) {
      reportSDStage('@all','c3-controller-ram-unavailable',{message:error?.message || String(error)});
      throw error;
    } finally {
      busy = false;
      renderSDInbox();
    }
  }
  // Read-only post-sync diagnostics. Never send another SD catalogue,
  // delete, format or remount just to check a completed BLE download.
  async function reportC3PostSync(path, connection) {
    if (root.SynapModules?.client?.module?.id !== 2 ||
        root.SynapDevices?.connection !== connection) return null;
    let cardAvailable = null;
    const trace = await reportC3SyncTrace(path, connection, 'verified');
    if (trace?.sdState === 2) cardAvailable = false;
    try {
      const response = await client().request(27);
      const diag = JSON.parse(new TextDecoder().decode(response.bytes));
      if (diag.sdState === 2) cardAvailable = false;
      reportSDStage(path, 'c3-post-sync-readonly', {
        ioOp: diag.ioOp ?? null,
        ioStep: diag.ioStep ?? null,
        ioErr: diag.ioErr ?? null,
        sdState: diag.sdState ?? null,
        sdLiveProbe: diag.sdLiveProbe ?? null,
        historicRecordStage: diag.recordStage ?? null,
      });
    } catch (error) {
      reportSDStage(path, 'c3-post-sync-diagnostic-unavailable', {
        message: error?.message || String(error),
      });
    }
    try {
      await root.SynapModules?.refresh?.();
      if (root.SynapDevices?.connection !== connection) return null;
      const info = root.SynapModules?.client?.module;
      if (info?.sdDetectionState === 2) cardAvailable = false;
      else if (info?.sdDetectionState === 1 && info?.sdLiveProbeState === 6 && cardAvailable !== false)
        cardAvailable = true;
      reportSDStage(path, 'c3-post-sync-link-state', {
        sdDetectionState: info?.sdDetectionState ?? null,
        sdLiveProbeState: info?.sdLiveProbeState ?? null,
        historicRecordStage: info?.sdProbeState ?? null,
      });
    } catch (_) {
      reportSDStage(path, 'c3-post-sync-link-status-unavailable');
    }
    if (cardAvailable === false) {
      // The local import and receipt were already durably verified. Only
      // stop further C3 SD reads: do not remount, format or delete the source.
      reportSDStage(path, 'c3-sd-unavailable-after-sync', {
        message: 'Saved in Memories; SD became unavailable during the download.',
      });
    }
    return cardAvailable;
  }
  async function syncAll() {
    if (busy) throw Error('Another device media transfer is already running.');
    const isC3 = root.SynapModules?.client?.module?.id === 2;
    if (isC3 && !api()?.state?.storageReady)
      throw Error('C3 SD card is unavailable. Do not repeat BLE reads until storage is recovered.');
    let files = api()?.state?.sdFiles?.slice?.() || [];
    if (!files.length) {
      await api().catalogue();
      files = api()?.state?.sdFiles?.slice?.() || [];
    }
    const pending = files.filter(
      (file) => file.syncable !== false && Number(file.bytes) > 44 && !isSDSynced(file.path),
    );
    if (!pending.length) return { synced: 0, failed: 0, paths: [] };
    let synced = 0, failed = 0, lastError = '', sdUnavailableAfterSync = false;
    const paths = [];
    for (const file of pending) {
      try {
        const result = await moveSD(file.path, (fraction) =>
          status('Syncing offline captures · ' + (synced + failed + 1) + '/' + pending.length + ' · ' + Math.round(fraction * 100) + '%'),
        );
        synced++;
        paths.push(file.path);
        if (isC3 && result?.sdAvailableAfterSync === false) {
          // Verified Memories copy survives; do not request the next WAV.
          sdUnavailableAfterSync = true;
          reportSDStage(file.path, 'c3-batch-paused-card-unavailable');
          break;
        }
      } catch (error) {
        failed++;
        lastError = error.message;
        // Stop at the FIRST C3 read error. A second WAV and a fresh op7
        // catalogue could further stress an already failing SD controller.
        // The earlier successfully imported files and receipts are durable.
        if (isC3) {
          reportSDStage(file.path, 'c3-batch-stopped-after-read-error', {
            message: lastError, mediaCode: error?.mediaCode ?? null,
          });
          break;
        }
      }
    }
    // C3: never traverse FAT again immediately after a verified WAV import.
    // Retain the existing catalogue snapshot; user may explicitly refresh.
    if (!isC3) await api().catalogue().catch(() => {});
    if (failed)
      throw Error(synced + ' synced; ' + failed + ' kept on SD because verification failed. ' + lastError);
    return { synced, failed: 0, paths, sdUnavailableAfterSync };
  }
  async function offerDeleteSynced(paths) {
    // C3 read reliability is under investigation. Never chain op17 unlink
    // onto a just-completed SD download. A separate, explicit Delete from SD
    // remains available after the user reviews the durable Memory.
    if (root.SynapModules?.client?.module?.id === 2) {
      reportSDStage('@all', 'c3-synced-originals-preserved', {
        count: new Set(paths || []).size,
      });
      return 0;
    }
    const unique = [...new Set(paths || [])];
    if (!unique.length) return 0;
    const message = unique.length === 1
      ? 'Sync completed. Delete the synced recording from the device SD card now? The copy in Memories will be kept.'
      : 'Sync completed for ' + unique.length + ' recordings. Delete these synced copies from the device SD card now? The copies in Memories will be kept.';
    if (!confirm(message)) return 0;
    let deleted = 0;
    for (const path of unique) {
      await deleteSDItem(path);
      deleted++;
    }
    return deleted;
  }
  function upgradeUi() {
    const length = document.getElementById('visualSDLength');
    if (length && length.tagName === 'SELECT') {
      const input = document.createElement('input');
      input.id = 'visualSDLength';
      input.type = 'number';
      input.min = '1';
      input.max = '600';
      input.step = '1';
      input.value = '10';
      input.setAttribute('aria-label', 'SD video length in seconds');
      length.replaceWith(input);
    }
    const quality = document.getElementById('visualSDQuality');
    if (quality?.options?.length >= 2) {
      quality.options[0].textContent = 'Maximum detail';
      quality.options[1].textContent = 'HD motion';
    }
    const record = document.getElementById('visualRecordSD');
    if (record) record.disabled = true;
    const browse = document.getElementById('visualSD');
    browse?.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        browseSD().catch((error) => status(error.message));
      },
      true,
    );
    const sync = document.getElementById('visualSyncSD');
    sync?.addEventListener('click', async () => {
      sync.disabled = true;
      try {
        const result = await syncAll();
        const deleted = await offerDeleteSynced(result.paths);
        status(result.synced
          ? result.synced + ' offline capture' + (result.synced === 1 ? '' : 's') + ' synced to Memories' +
            (deleted ? ' · ' + deleted + ' SD cop' + (deleted === 1 ? 'y deleted.' : 'ies deleted.') : ' · SD cop' + (result.synced === 1 ? 'y kept.' : 'ies kept.')) + 
              (result.sdUnavailableAfterSync ? ' C3 SD is now unavailable; batch stopped safely. No further SD reads or format.' : '')
          : 'No unsynced offline captures waiting.');
      } catch (error) {
        status(error.message);
      } finally {
        sync.disabled = false;
        renderSDInbox();
      }
    });
    const libraryInfoToggle = document.getElementById('libraryStorageInfoToggle');
    libraryInfoToggle?.addEventListener('click', () => {
      const open = libraryInfoToggle.getAttribute('aria-expanded') === 'true';
      libraryInfoToggle.setAttribute('aria-expanded', String(!open));
      renderSDInbox();
    });
    const libraryCheck = document.getElementById('libraryCheckSD');
    libraryCheck?.addEventListener('click', async () => {
      libraryCheck.disabled = true;
      try {
        status('Checking pendant SD…');
        await api().refreshSD();
        await api().syncPendingSD().catch(() => {});
      } catch (error) {
        status(error.message);
      } finally {
        libraryCheck.disabled = false;
        renderSDInbox();
      }
    });
    const libraryBrowse = document.getElementById('libraryBrowseSD');
    libraryBrowse?.addEventListener('click', async () => {
      libraryBrowse.disabled = true;
      try {
        // User-requested inspection only. This button must work on C3 too;
        // unlike the sync-completion path it is an explicit FAT read.
        await browseSD('librarySDList');
      } catch (error) {
        status(error.message);
      } finally {
        libraryBrowse.disabled = false;
        renderSDInbox();
      }
    });
    const librarySync = document.getElementById('librarySyncSD');
    librarySync?.addEventListener('click', async () => {
      librarySync.disabled = true;
      try {
        const result = await syncAll();
        const deleted = await offerDeleteSynced(result.paths);
        status(
          result.synced
            ? result.synced + ' offline capture' + (result.synced === 1 ? '' : 's') + ' synced to Memories' +
              (deleted ? ' · ' + deleted + ' SD cop' + (deleted === 1 ? 'y deleted.' : 'ies deleted.') : ' · SD cop' + (result.synced === 1 ? 'y kept.' : 'ies kept.')) + 
              (result.sdUnavailableAfterSync ? ' C3 SD is now unavailable; batch stopped safely. No further SD reads or format.' : '')
            : 'No unsynced offline captures waiting.',
        );
        // Critical Odyssey C3 invariant: a completed BLE WAV import must
        // NOT immediately issue a new op7 FAT catalogue traversal.
        // Only an explicit Browse SD click may issue this read.
        if (root.SynapModules?.client?.module?.id !== 2)
          await browseSD('librarySDList');
      } catch (error) {
        status(error.message);
      } finally {
        librarySync.disabled = false;
        renderSDInbox();
      }
    });
    const extras = document.getElementById('settingsDeviceExtras');
    if (extras && !document.getElementById('deviceSDSettings')) {
      const card = document.createElement('section');
      card.id = 'deviceSDSettings';
      card.className = 'settings-card';
      card.hidden = true;
      card.innerHTML =
        '<h3 class="settings-card-title">SD card</h3>' +
        '<p id="deviceSDSettingsStatus" class="settings-hint">Connect a supported pendant to manage SD storage.</p>' +
         '<p id="deviceSDSpeed" class="settings-hint" aria-live="off" hidden></p>' +
        '<p id="deviceSDCapacity" class="settings-hint" role="status">SD capacity: connect and choose Check capacity.</p>' +
        '<div class="visual-actions"><button id="retryDeviceSD" type="button">Recover SD</button><button id="checkDeviceSDCapacity" type="button">Check capacity</button><button id="diagnoseDeviceSD" type="button" hidden>Diagnose SD (read-only)</button><button id="diagnoseDeviceSDRam" type="button" hidden>SD controller status (RAM-only)</button><button id="diagnoseDeviceSDRecorder" type="button" hidden>Recorder fault details</button><button id="clearDeviceSD" type="button">Clear SD Card</button><button id="formatDeviceSD" type="button" hidden>Format SD Card</button><button id="emergencyFormatDeviceSD" type="button" hidden>Emergency SD reformat (erases all)</button></div>' +
        '<p id="deviceSDRawStatus" class="settings-hint" role="status" hidden></p>';
      extras.append(card);
      document.getElementById('retryDeviceSD')?.addEventListener('click', async () => {
        const button = document.getElementById('retryDeviceSD'),
          settingsStatus = document.getElementById('deviceSDSettingsStatus');
        button.disabled = true;
        if (settingsStatus) settingsStatus.textContent = 'Retrying SD card…';
        try {
          await api().refreshSD();
          const info = root.SynapModules?.client?.module;
          if (info?.sdDetectionState === 1 && info?.sdLiveProbeState === 6) {
            if (settingsStatus) settingsStatus.textContent = 'SD card recovered · refreshing offline content…';
            await api().syncPendingSD().catch(() => {});
          } else if (settingsStatus) {
            settingsStatus.textContent =
              'SD retry finished · detection ' +
              String(info?.sdDetectionState ?? 'unknown') +
              ' / live probe ' +
              String(info?.sdLiveProbeState ?? 'unknown') +
              ' / historical recorder stage ' +
              String(info?.sdProbeState ?? 'unknown') +
              '.';
          }
        } catch (error) {
          if (settingsStatus) settingsStatus.textContent = 'SD retry failed · ' + error.message;
          status(error.message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
      document.getElementById('checkDeviceSDCapacity')?.addEventListener('click', async () => {
        const button=document.getElementById('checkDeviceSDCapacity');
        button.disabled=true;
        try {
          const data=await checkSDCapacity();
          status('SD FAT storage '+sdBytesLabel(data.totalBytes)+' · Free '+sdBytesLabel(data.freeBytes));
        } catch(error) {
          status('SD capacity unavailable · '+error.message);
        } finally {
          renderSDInbox();
        }
      });
      document.getElementById('diagnoseDeviceSDRecorder')?.addEventListener('click',async()=>{
        const button=document.getElementById('diagnoseDeviceSDRecorder');
        const output=document.getElementById('deviceSDRawStatus');
        button.disabled=true;
        if(output){output.hidden=false;output.textContent='Reading recorder fault (no SD card access)…';}
        try {
          const response=await client().request(34);
          const data=JSON.parse(new TextDecoder().decode(response.bytes));
          if(data?.version!==1 ||
              !['stage','bytes','faultLed','micRestarts','sdState','sdLiveProbe',
                'readQuarantine','writeQuarantine'].every(k=>Number.isSafeInteger(data[k])))
            throw Error('Invalid recorder health response');
          const stage=data.stage, live=data.sdLiveProbe;
          // op34 adds optional RAM-only boot recovery signals in newer C3
          // firmware; older devices continue to provide the original v1 keys.
          const coldRecovery=Number.isSafeInteger(data.coldRecovery)?data.coldRecovery:0;
          const resetReason=Number.isSafeInteger(data.resetReason)?data.resetReason:null;
          const cleanupRemoved=Number.isSafeInteger(data.cleanupRemoved)?data.cleanupRemoved:null;
          const cleanupStatus=Number.isSafeInteger(data.cleanupStatus)?data.cleanupStatus:null;
          const cleanupNote=cleanupStatus===1
            ? ' Cold-boot cleanup removed '+cleanupRemoved+' empty Synap WAV/temporary file(s); files with recoverable audio were kept.'
            : cleanupStatus===2
              ? ' Cold-boot cleanup stopped after SD read/write trouble. No further cleanup or same-rail retry is safe.'
              : cleanupStatus===3
                ? ' Additional empty artifacts remain for a later verified cold boot.'
                : '';
          const restored=Boolean(data.sdState===1 && live===6 &&
            !data.writeQuarantine && !data.readQuarantine);
          const coldNote=coldRecovery===1
            ? ' Cold slider power-on verified a fresh FAT mount; normal SD recording and sync have resumed.'
            : coldRecovery===2
              ? ' Cold mount could not be verified; unplug USB, slider OFF for 30 seconds, then ON. Do not format.'
              : coldRecovery===3
                ? ' MCU-only reboot left SD power uncertain. Unplug USB and cycle the physical slider before retrying.'
                : '';
          let reason = data.writeQuarantine
            ? 'SD write/controller failure — further card commands are blocked. Remove all pendant and SD power; do NOT retry or format on the same power rail.'
            : data.readQuarantine
              ? 'SD read timed out — protect recordings and fully power-cycle the SD supply before recovering.'
              : restored && stage>=44 && stage!==48
                ? 'Historical recorder storage fault retained for diagnostics; current SD FAT is verified mounted.'
                : stage===43
                  ? 'Microphone I2S fault — no evidence in this record of an SD write error.'
                : stage===52 || stage===68
                  ? 'SD storage full — original files should remain accessible. Sync before manually formatting.'
                  : stage>=40
                    ? 'Offline recorder reported a storage or file verification failure (stage '+stage+'). This does not prove the SD card is absent; preserve existing WAV files.'
                    : 'No retained recorder fault.';
          const code=data.faultLed;
          const red=code===4?'4 red flashes = blocked SD/controller':
            code===3?'3 red flashes = microphone fault':
              code===2?'2 red flashes = SD/file error':'No current red-fault indication';
          const message='Recorder: '+reason+' '+red+
            ' · FAT probe '+live+' · Recorded '+data.bytes+' PCM bytes'+
            ' · Mic restarts '+data.micRestarts+
            ' · SD mounted '+(data.sdState===1?'yes':'no')+
            (resetReason===null?'':' · Boot reset '+resetReason)+'.'+coldNote+cleanupNote;
          reportSDStage('@all','c3-recorder-health-readonly',{
            stage,bytes:data.bytes,faultLed:code,micRestarts:data.micRestarts,
            sdState:data.sdState,sdLiveProbe:live,
            readQuarantine:data.readQuarantine,writeQuarantine:data.writeQuarantine,
            coldRecovery,resetReason,restored,cleanupRemoved,cleanupStatus
          });
          if(output)output.textContent=message;
          status(message);
        }catch(error){
          const message='Recorder fault status unavailable. Update the C3 firmware to the latest build. '+error.message;
          if(output)output.textContent=message;
          status(message);
        }finally{button.disabled=false;renderSDInbox();}
      });
      document.getElementById('diagnoseDeviceSDRam')?.addEventListener('click', async () => {
        const button = document.getElementById('diagnoseDeviceSDRam'),
          output = document.getElementById('deviceSDRawStatus');
        button.disabled = true;
        if (output) {
          output.hidden = false;
          output.textContent = 'Reading SD controller RAM (no card access)…';
        }
        try {
          const message = await diagnoseC3SdWireReadOnly();
          if (output) output.textContent = message;
          status(message);
        } catch (error) {
          const message = 'SD controller RAM diagnostic unavailable · ' + error.message;
          if (output) output.textContent = message;
          status(message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
      document.getElementById('diagnoseDeviceSD')?.addEventListener('click', async () => {
        const button = document.getElementById('diagnoseDeviceSD'),
          output = document.getElementById('deviceSDRawStatus');
        button.disabled = true;
        if (output) {
          output.hidden = false;
          output.textContent = 'Reading SD sector 0 (no writes or format)…';
        }
        try {
          const diagnosis = await diagnoseC3SdReadOnly();
          if (output) output.textContent = diagnosis.message;
          status(diagnosis.message);
        } catch (error) {
          const message = 'Read-only SD diagnosis unavailable · ' + error.message;
          if (output) output.textContent = message;
          status(message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
      document.getElementById('clearDeviceSD')?.addEventListener('click', async () => {
        if (
          !confirm(
            root.SynapModules?.client?.module?.id === 2
              ? 'Remove up to 100 Synap recordings from this device SD card? If more remain, repeat Clear SD Card. Unrelated files are kept. This cannot be undone.'
              : 'Remove all Synap captures from this device SD card? Unrelated files are kept. This cannot be undone.',
          )
        )
          return;
        const button = document.getElementById('clearDeviceSD');
        button.disabled = true;
        try {
          const count = await clearSD();
          status(
            'Cleared ' +
              count +
              ' Synap capture' +
              (count === 1 ? '' : 's') +
              ' from the SD card.' +
              (root.SynapModules?.client?.module?.id === 2 && count >= 100
                ? ' More files may remain; check the SD list and clear again if needed.'
                : ''),
          );
          await api().syncPendingSD().catch(() => {});
        } catch (error) {
          status(error.message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
      document.getElementById('emergencyFormatDeviceSD')?.addEventListener('click',async()=>{
        if (!confirm('EMERGENCY SD REFORMAT: This may PERMANENTLY ERASE EVERY FILE, including unsynced recordings. Only proceed after fully cutting power to the SD card and attempting Recover SD. A stuck CMD24/CMD25 controller CANNOT be fixed by software format. Continue?'))
          return;
        if (root.prompt('Type ERASE SD to authorize potential loss of ALL SD recordings:')!=='ERASE SD')
          return;
        const button=document.getElementById('emergencyFormatDeviceSD');
        const settingsStatus=document.getElementById('deviceSDSettingsStatus');
        button.disabled=true;
        if (settingsStatus) settingsStatus.textContent='Emergency FAT recovery: do not disconnect power…';
        try {
          await emergencyFormatSD();
          if(settingsStatus) settingsStatus.textContent='Emergency FAT recovery finished; inspect the SD recordings and check capacity.';
        } catch(error) {
          if(settingsStatus) settingsStatus.textContent='Emergency recovery failed or refused · '+error.message;
          status(error.message);
        } finally {
          renderSDInbox();
        }
      });
      document.getElementById('formatDeviceSD')?.addEventListener('click', async () => {
        if (!confirm(
          'Format this SD card? ALL files on the card will be permanently erased, including non-Synap files. This cannot be undone. Back up all recordings first.'
        )) return;
        if (root.prompt('Type FORMAT SD to confirm permanent erasure of ALL files:') !== 'FORMAT SD')
          return;
        const button = document.getElementById('formatDeviceSD'),
          settingsStatus = document.getElementById('deviceSDSettingsStatus');
        button.disabled = true;
        if (settingsStatus) settingsStatus.textContent = 'Formatting SD card…';
        try {
          await formatSD();
          if (settingsStatus) settingsStatus.textContent = 'SD card formatted · ready for offline recording.';
        } catch (error) {
          if (settingsStatus) settingsStatus.textContent = 'SD format failed · ' + error.message;
          status(error.message);
        } finally {
          button.disabled = false;
          renderSDInbox();
        }
      });
    }
    // Odyssey C3 is BLE-only: no Wi-Fi settings or hotspot controls.
    if (browse?.parentNode && !document.getElementById('visualClearSD')) {
      const clear = document.createElement('button');
      clear.id = 'visualClearSD';
      clear.type = 'button';
      clear.textContent = c3MaintenanceWritesBlocked() ? 'Clear SD (disabled)' : 'Clear SD';
      clear.disabled = c3MaintenanceWritesBlocked();
      if (clear.disabled) clear.title = C3_SD_WRITE_SAFETY_MESSAGE;
      clear.addEventListener('click', async () => {
        if (!confirm('Remove all Synap captures from this device SD card? Unrelated files are kept.')) return;
        clear.disabled = true;
        try {
          const count = await clearSD();
          status('Cleared ' + count + ' Synap capture' + (count === 1 ? '' : 's') + ' from SD.');
          await browseSD();
        } catch (error) {
          status(error.message);
        } finally {
          clear.disabled = false;
        }
      });
      browse.parentNode.insertBefore(clear, browse.nextSibling);
    }
  }
  const exposed = {
    checkSDCapacity,
    emergencyFormatSD,
    moveSD,
    moveC3Wifi,
    c3ApStatus,
    startC3Ap,
    stopC3Ap,
    c3WifiStatus,
    configureC3Wifi,
    forgetC3Wifi,
    discardIncompleteSD,
    deleteSDItem,
    isSDSynced,
    storedReceipt,
    syncAll,
    clearSD,
    formatSD,
    diagnoseC3SdReadOnly,
    startOffline,
    startOfflineAudio,
    describeNow,
    browseSD,
    renderSDInbox,
    isC3ApHandoffActive: () => false, // Retired C3 Wi-Fi must not veto BLE reconnect.
    get busy() { return busy; },
  };
  root.SynapChakshuV2 = exposed;
  for (const name of ['synap-chakshu-changed', 'synap-module-changed', 'synap-chakshu-sd-pending', 'synap-gatt-disconnected'])
    root.addEventListener?.(name, renderSDInbox);
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => { upgradeUi(); renderSDInbox(); }, { once: true });
  else { upgradeUi(); renderSDInbox(); }
})(globalThis);