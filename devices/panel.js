/* The Device panel follows the connected module's supported and ready flags. */
(function (root) {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const labels = {
    audio: 'Microphone',
    camera: 'Camera',
    sd: 'SD card',
    touch: 'Touch control',
    battery: 'Battery sensor',
    standby: 'Standby',
  };
  function render() {
    const panel = byId('moduleSettings'),
      api = root.SynapModules,
      client = api?.client,
      info = client?.module;
    if (!panel) return;
    panel.hidden = !client;
    const detailsUnavailable = client?.available && !info;
    byId('moduleName').textContent = info
      ? info.name
      : detailsUnavailable
        ? 'Audio pendant'
        : 'Detecting module…';
    byId('moduleBoard').textContent = info
      ? info.board
      : detailsUnavailable
        ? 'Extra device features are unavailable on this connection.'
        : 'Reading connected hardware';
    const chips = byId('moduleFeatures');
    chips.replaceChildren();
    const c3OfflineWriter = Boolean(
      info &&
      info.id === 2 &&
      info.mediaVersion === 0 &&
      root.SynapCapabilities.supports(info, 'sd') &&
      root.SynapCapabilities.supports(info, 'sdAudio')
    );
    if (info)
      for (const [key, label] of Object.entries(labels)) {
        if (!root.SynapCapabilities.supports(info, key)) continue;
        const chip = document.createElement('span');
        chip.className = 'module-feature';
        const ready = root.SynapCapabilities.ready(info, key);
        if (key === 'sd' && c3OfflineWriter) {
          chip.textContent = 'SD card · offline recorder';
          chip.dataset.ready = 'unknown';
        } else {
          chip.textContent = label + (info.legacy ? '' : ready ? ' · ready' : ' · unavailable');
          chip.dataset.ready = info.legacy ? 'unknown' : String(ready);
        }
        chips.append(chip);
      }
    if (info && [1, 2].includes(info.id)) {
      const chip = document.createElement('span');
      chip.className = 'module-feature';
      const state = info.sdDetectionState;
      chip.textContent = 'SD card · ' + (c3OfflineWriter
        ? state === 1 ? 'last offline check succeeded'
          : state === 2 ? 'last offline check failed'
            : state === 3 ? 'no card on last offline check'
              : state === 0 ? 'checked on offline double-tap'
                : 'offline check status unavailable'
        : state === 1 ? 'detected at startup'
          : state === 2 ? 'check failed at startup' : state === 3 ? 'not detected at startup'
            : state === 0 ? 'not checked' : 'update firmware to check');
      chip.dataset.ready = state === 1 ? 'true' : state === 2 || state === 3 ? 'false' : 'unknown';
      chips.append(chip);
    }
    const caps = root.SynapCapabilities,
      chakshu = caps.isChakshu(info),
      status = client?.status;
    const experience = byId('moduleExperience');
    if (experience) {
      const recoveryMs = root.SynapDisconnectProtection?.capacityMs() || 0;
      experience.textContent = !info
        ? ''
        : chakshu
          ? 'Audio builds transcripts and memories. Photos, video and soundtracks stay local. Touch control, battery telemetry and standby follow the same device controls as Odyssey when the connected firmware reports them ready. Hey Snap listens on Chakshu while idle, even with Bluetooth connected. Starting live PWA audio temporarily pauses it, so the microphone has one owner.'
          : caps.profile(info)
            ? 'Audio recording, transcripts and memories.' +
              (caps.ready(info, 'touch') ? ' Touch control is available.' : '') +
              (recoveryMs
                ? ' Audio recovery: up to ' +
                  Math.round(recoveryMs / 10) / 100 +
                  ' seconds across brief disconnects.'
                : ' Keep the app open and your pendant nearby for continuous audio.')
            : 'Capabilities could not be verified. Refresh status before recording.';
    }
    byId('chakshuChecks').hidden = !chakshu;
    const voiceHost=byId('chakshuHeySnap'),voiceStatus=byId('chakshuVoiceStatus'),
      voiceToggle=byId('chakshuVoiceToggle'),voiceDiagnose=byId('chakshuVoiceDiagnose');
    const hasVoice=Boolean(chakshu && caps.hasVoice(info));
    if(voiceHost)voiceHost.hidden=!hasVoice;
    if(hasVoice && voiceStatus){
      const voice=root.SynapChakshuVoice?.state;
      const states=['Initializing microphone model','Listening for “Hey Snap” (experimental)',
        'Voice model not initialized','Not enough memory for voice model','Voice model error','Hey Snap disabled'];
      const recording=Boolean(root.SynapAppControls?.recordingState?.()?.active);
      const text=voice
        ? (recording && voice.status===1 ? 'Paused during PWA audio capture' :
           (states[voice.status]||'Voice status unavailable'))
        : 'Reading Hey Snap state…';
      const sdReady=caps.ready(info,'sd');
      voiceStatus.textContent=text+(sdReady?'':' · SD unavailable: picture comprehension and video cannot be saved.')+
        (root.SynapChakshuVoice?.message && voice?.status===1 ? ' · '+root.SynapChakshuVoice.message : '');
      if(voiceToggle){
        voiceToggle.disabled=!voice;
        voiceToggle.textContent=voice?.enabled?'Disable Hey Snap':'Enable Hey Snap';
      }
      if(voiceDiagnose)voiceDiagnose.disabled=!voice;
      const videoLength=byId('chakshuVoiceVideoSeconds');
      if(videoLength){videoLength.disabled=!voice || !voice.enabled;videoLength.value=String(voice?.videoSeconds||10);}
    }
    byId('moduleRefresh').disabled = !client || client.pending || client.busy;
    if (!chakshu) {
      byId('moduleStatus').textContent =
        client?.error ||
        (info?.legacy ? 'Earlier firmware detected. Update for hardware readiness checks.'
          : c3OfflineWriter
            ? 'Offline SD validation mode. The card is mounted only after the app is disconnected and a double-tap starts recording. SD browsing and sync are intentionally disabled in this firmware.'
          : info?.id === 2 && info?.sdDetectionState === 2 &&
              Number(info?.sdProbeState) >= 40 &&
              ![48, 52, 68].includes(Number(info?.sdProbeState))
            ? 'Offline SD write or file verification failed. SD access is paused for safety; the card is not confirmed absent. After a complete SD power cycle, a successful FAT mount restores normal recording and sync. Preserve existing WAVs.'
          : caps.hasMedia(info) && caps.supports(info, 'sd')
            ? caps.ready(info, 'sd')
              ? 'SD card ready. Offline WAV recordings appear in Memories while BLE is connected.'
              : info?.id === 2 && info?.sdProbeState === 1
                ? 'SD SPI bus setup failed.'
                : info?.id === 2 && info?.sdProbeState === 2
                  ? 'SD card protocol initialization failed.'
                  : info?.id === 2 && info?.sdProbeState === 3
                    ? 'SD card initialized, but the FAT filesystem could not be mounted.'
                    : info?.id === 2 && info?.sdProbeState === 4
                      ? 'SD filesystem mounted, but VFS validation failed.'
                      : 'SD access is not ready. Check the mount diagnostics; card absence is not established.'
            : info?.sdDetectionState === 1
              ? 'SD card detected at startup. Restart the pendant after changing the card.'
              : info?.sdDetectionState === 2
                ? 'SD check failed at startup. Check the card, wiring and filesystem, then restart the pendant. Refresh status reads the last startup result.'
                : info?.sdDetectionState === 3
                  ? 'No SD card reported at startup. Check the card and wiring, then restart the pendant.'
                  : '');
      return;
    }
    byId('chakshuStorage').textContent =
      status?.ready & 4
        ? status.freeMiB.toLocaleString() +
          ' MiB free of ' +
          status.totalMiB.toLocaleString() +
          ' MiB'
        : 'SD card unavailable · check the card, then refresh hardware';
    byId('chakshuCamera').textContent =
      info.sensor === 0x3660
        ? 'OV3660 camera'
        : info.sensor
          ? 'Camera sensor 0x' + info.sensor.toString(16).toUpperCase()
          : 'Camera sensor unavailable';
    const names = {
      1: 'Checking hardware',
      2: 'Saving photo',
      3: 'Recording 10-second WAV',
      4: 'Recording silent camera clip',
    };
    const result =
      client.error ||
      (status?.state === 3
        ? api.ERRORS[status.error] || 'Hardware check failed.'
        : status?.state === 1
          ? (names[status.operation] || 'Working') + '… ' + status.progress + '%'
          : status?.state === 2
            ? status.operation === 1
              ? 'Hardware check complete.'
              : 'Saved ' + status.bytes.toLocaleString() + ' bytes to SD.'
            : 'Ready for a hardware check.');
    byId('moduleStatus').textContent = result;
    byId('chakshuFile').textContent = client.path
      ? (status?.state === 3 ? 'Partial file: ' : 'File: ') + client.path
      : '';
    for (const button of document.querySelectorAll('[data-chakshu-operation]')) {
      const op = Number(button.dataset.chakshuOperation);
      const ready = caps.hardwareCheck(info, op, true);
      button.disabled =
        client.pending || client.busy || !ready || client.context.canUse?.() === false;
    }
    const progress = byId('chakshuProgress');
    progress.hidden = !client.busy;
    progress.value = status?.progress || 0;
  }
  function init() {
    byId('moduleRefresh')?.addEventListener('click', () => root.SynapModules.refresh());
    for (const button of document.querySelectorAll('[data-chakshu-operation]'))
      button.addEventListener('click', async () => {
        try {
          await root.SynapModules.run(Number(button.dataset.chakshuOperation));
        } catch (error) {
          byId('moduleStatus').textContent = error.message;
        }
        render();
      });
    byId('chakshuVoiceToggle')?.addEventListener('click',async()=>{
      const button=byId('chakshuVoiceToggle');
      button.disabled=true;
      try {
        const on=Boolean(root.SynapChakshuVoice?.state?.enabled);
        await root.SynapChakshuVoice.enabled(!on);
      } catch(error){byId('chakshuVoiceStatus').textContent=error.message;}
      finally{render();}
    });
    byId('chakshuVoiceVideoSeconds')?.addEventListener('change',async(event)=>{
      const select=event.currentTarget;
      select.disabled=true;
      try{await root.SynapChakshuVoice.setVideoSeconds(Number(select.value));}
      catch(error){byId('chakshuVoiceStatus').textContent=error.message;}
      finally{render();}
    });
    byId('chakshuVoiceDiagnose')?.addEventListener('click',async()=>{
      const button=byId('chakshuVoiceDiagnose');
      button.disabled=true;
      try {
        const reading=await root.SynapChakshuVoice.diagnose();
        byId('chakshuVoiceDiagnostic').textContent=
          'Mic activity: '+reading.meanAbs+' AC / peak '+reading.peak+
          ' · last candidate: '+reading.candidate+
          ' ('+Math.round(reading.confidence*100)+'% model confidence)'+
          (reading.active?' · listener active':' · listener not active');
      }catch(error){byId('chakshuVoiceDiagnostic').textContent=error.message;}
      finally{button.disabled=false;}
    });
    root.addEventListener('synap-chakshu-voice',render);
    root.addEventListener('synap-chakshu-voice-result',render);
    root.addEventListener('synap-module-changed', render);
    render();
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
