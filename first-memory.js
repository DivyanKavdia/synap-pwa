/* First-use guidance consumes the app's existing Library snapshot. The sample
 * is a separate, explicitly illustrative view: it never writes user data. */
(function (root) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let snapshot = null,
    busy = false,
    initialized = false,
    lastFocus = null;
  function update(value) {
    snapshot = value;
    render();
  }
  function settings() {
    try {
      return JSON.parse(localStorage.getItem('dk-pendant-settings') || '{}');
    } catch {
      return {};
    }
  }
  function render() {
    if (!initialized || !snapshot) return;
    const recording = snapshot.recording;
    const ready = recording && (recording.summary?.trim() || recording.processingStage === 'ready');
    const anotherOwner =
      recording?.ownerUid &&
      root.SynapAuth?.session()?.profile?.uid &&
      recording.ownerUid !== root.SynapAuth.session().profile.uid;
    const show = snapshot.count <= 1 && !ready && !anotherOwner;
    $('firstMemory').hidden = !show;
    document.body.dataset.firstMemory = String(show);
    if (!show) return;
    const desktop = root.SynapDesktopCapture?.state() || {};
    const capture = root.SynapAppControls?.recordingState() || {};
    const startupReady = document.body.dataset.startup === 'ready';
    const saved =
      recording && recording.status !== 'recording' && !capture.active && !desktop.active;
    const model = saved
      ? root.SynapProcessingPipeline?.derive(
          recording,
          (snapshot.jobs || []).filter((job) => job.recordingId === recording.id),
          {
            provider: 'synap',
            signedIn: Boolean(root.SynapAuth?.isSignedIn()),
            autoProcess: settings().autoProcess === true,
          },
        )
      : null;
    const processing = model?.tone === 'active';
    $('firstMemoryTitle').textContent = saved
      ? 'Bring your first memory to life.'
      : 'Your next conversation, remembered.';
    $('firstMemoryCopy').textContent = saved
      ? 'Your recording is in Library. Create a memory to find its decisions, next steps, and original words.'
      : 'Stay in the conversation. synap helps you return to what was decided and what happens next.';
    const primary = $('firstMemoryRecord');
    primary.textContent = saved
      ? processing
        ? model.status
        : model?.tone === 'error'
          ? 'Retry creating memory'
          : 'Create memory'
      : capture.active
        ? capture.canStop
          ? 'Stop & save recording'
          : 'Saving recording…'
        : 'Record with pendant';
    const pendantPending =
      ['connecting', 'starting', 'stopping', 'saving', 'updating'].includes(
        document.body.dataset.state,
      ) && !capture.canStop;
    primary.disabled =
      busy ||
      !startupReady ||
      Boolean(desktop.active) ||
      Boolean(processing) ||
      pendantPending ||
      (capture.active && !capture.canStop) ||
      (!saved && !capture.active && !root.navigator?.bluetooth);
    const meeting = $('firstMemoryMeeting');
    meeting.hidden = Boolean(saved) || !root.SynapDesktopCapture?.supported();
    meeting.textContent = desktop.active
      ? {
          starting: 'Preparing meeting…',
          saving: 'Saving meeting…',
          'save-failed': 'Retry saving meeting',
        }[desktop.phase] || 'Stop & save meeting'
      : 'Record an online meeting';
    meeting.disabled =
      busy ||
      !startupReady ||
      Boolean(capture.active) ||
      ['starting', 'saving'].includes(desktop.phase);
    const note = $('firstMemoryHint');
    note.textContent =
      desktop.phase === 'save-failed'
        ? 'Audio is waiting to be saved. Keep this page open and retry saving.'
        : desktop.active
          ? 'Keep this page open. Stop and save when the meeting ends.'
          : capture.active
            ? 'Keep synap open while recording. You can mark important moments above.'
            : saved
              ? model?.error || 'You can listen to the original recording in Library at any time.'
              : root.navigator?.bluetooth
                ? 'Double-tap either pendant to start or stop. Keep synap open during recording.'
                : 'Pendant recording needs a browser with Web Bluetooth. You can still explore the sample here.';
    $('firstMemoryAccount').textContent = root.SynapAuth?.isSignedIn()
      ? 'Memory settings'
      : 'Sign in for cloud memories';
  }
  async function record() {
    if (busy) return;
    busy = true;
    $('firstMemoryError').textContent = '';
    render();
    try {
      const capture = root.SynapAppControls?.recordingState() || {};
      const recording = snapshot?.recording;
      if (capture.active) await root.SynapAppControls.stopCapture(capture.sessionId);
      else if (recording && recording.status !== 'recording')
        await root.SynapLibraryTools.processIds([recording.id]);
      else await root.SynapAppControls.toggleCapture();
    } catch (error) {
      $('firstMemoryError').textContent = error.message || 'Please try again.';
    } finally {
      busy = false;
      render();
    }
  }
  async function meeting() {
    if (busy) return;
    busy = true;
    $('firstMemoryError').textContent = '';
    render();
    try {
      if (root.SynapDesktopCapture.state().active) await root.SynapDesktopCapture.stop();
      else await root.SynapDesktopCapture.start();
    } catch (error) {
      $('firstMemoryError').textContent =
        error.name === 'NotAllowedError'
          ? 'Audio sharing was cancelled. Choose a tab with audio when you are ready.'
          : error.message;
    } finally {
      busy = false;
      render();
    }
  }
  const periods = ['summary', 'actions', 'transcript'];
  function selectSample(period, focus = false) {
    if (!periods.includes(period)) return;
    for (const key of periods) {
      const tab = $('sampleTab-' + key);
      tab.setAttribute('aria-selected', String(key === period));
      tab.tabIndex = key === period ? 0 : -1;
      $('samplePanel-' + key).hidden = key !== period;
    }
    if (focus) $('sampleTab-' + period).focus();
  }
  function openSample() {
    if ($('sampleMemory')?.open) return;
    if (
      root.SynapAppControls?.recordingState()?.active ||
      root.SynapDesktopCapture?.state()?.active
    ) {
      if ($('firstMemoryError'))
        $('firstMemoryError').textContent =
          'Stop and save your recording before opening the sample.';
      return;
    }
    root.SynapSettingsPanel?.close();
    if (!$('sampleMemory')) {
      const dialog = document.createElement('dialog');
      dialog.id = 'sampleMemory';
      dialog.className = 'sample-memory';
      dialog.setAttribute('aria-labelledby', 'sampleMemoryTitle');
      dialog.setAttribute('aria-describedby', 'sampleMemoryDescription');
      dialog.innerHTML = `
        <header class="sample-header"><span class="sample-label">Illustrative sample</span><button type="button" id="closeSampleMemory" aria-label="Close sample">✕</button></header>
        <h2 id="sampleMemoryTitle">A focused pilot, a clear next step.</h2>
        <p id="sampleMemoryDescription">Explore a sample conversation. Nothing here is saved to your Library.</p>
        <div class="sample-tabs" role="tablist" aria-label="Sample memory">
          <button type="button" id="sampleTab-summary" role="tab" aria-controls="samplePanel-summary" aria-selected="true">Summary</button>
          <button type="button" id="sampleTab-actions" role="tab" aria-controls="samplePanel-actions" aria-selected="false" tabindex="-1">Next steps</button>
          <button type="button" id="sampleTab-transcript" role="tab" aria-controls="samplePanel-transcript" aria-selected="false" tabindex="-1">Transcript</button>
        </div>
        <section id="samplePanel-summary" class="sample-panel" role="tabpanel" aria-labelledby="sampleTab-summary" tabindex="0">
          <p>You and Maya agreed to start a pilot with five design partners. You will send invitations; Maya will share a feedback checklist. A start date has not been agreed.</p>
          <article class="sample-decision"><span class="sample-label">Decision</span><h3>Start with five design partners.</h3><button type="button" data-sample-source="24">View source · 0:24 <span aria-hidden="true">↗</span></button></article>
          <p class="sample-explainer">Every source button takes you back to the words behind the memory.</p>
        </section>
        <section id="samplePanel-actions" class="sample-panel" role="tabpanel" aria-labelledby="sampleTab-actions" tabindex="0" hidden>
          <article class="sample-task"><label><input id="sampleTaskDone" type="checkbox"><span><strong>Send pilot invitations</strong><small>You · No due date agreed</small></span></label><button type="button" data-sample-source="38">Source · 0:38</button></article>
          <article class="sample-task"><div><span class="sample-label">Waiting on Maya</span><h3>Share the feedback checklist</h3></div><button type="button" data-sample-source="46">Source · 0:46</button></article>
          <p class="sample-explainer">Try checking off the sample task. Your real actions are unchanged.</p>
        </section>
        <section id="samplePanel-transcript" class="sample-panel sample-transcript" role="tabpanel" aria-labelledby="sampleTab-transcript" tabindex="0" hidden>
          <p class="sample-explainer">Illustrative transcript · no audio recording</p>
          <p id="sampleSource-0" tabindex="-1"><small>0:00 · Maya</small>Could we start with a small group of design partners?</p>
          <p id="sampleSource-24" tabindex="-1"><small>0:24 · You</small>Let’s start with five design partners for the pilot.</p>
          <p id="sampleSource-38" tabindex="-1"><small>0:38 · You</small>I’ll send the pilot invitations.</p>
          <p id="sampleSource-46" tabindex="-1"><small>0:46 · Maya</small>I’ll share the feedback checklist.</p>
          <p id="sampleSource-63" tabindex="-1"><small>1:03 · You</small>We haven’t agreed on a start date yet.</p>
        </section>
        <footer class="sample-footer"><span>Your conversations make this yours.</span><button type="button" id="sampleBack">Back to synap</button></footer>`;
      document.body.appendChild(dialog);
      $('closeSampleMemory').addEventListener('click', () => dialog.close());
      $('sampleBack').addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => {
        if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
      });
      dialog.addEventListener('click', (event) => {
        const tab = event.target.closest('[role="tab"]');
        if (tab) selectSample(tab.id.slice('sampleTab-'.length));
        const source = event.target.closest('[data-sample-source]');
        if (source) {
          selectSample('transcript');
          dialog
            .querySelectorAll('[data-selected]')
            .forEach((node) => node.removeAttribute('data-selected'));
          const line = $('sampleSource-' + source.dataset.sampleSource);
          line.dataset.selected = 'true';
          line.focus({ preventScroll: true });
          line.scrollIntoView({ block: 'nearest' });
        }
      });
      dialog.querySelector('.sample-tabs').addEventListener('keydown', (event) => {
        const index = periods.indexOf(event.target.id.slice('sampleTab-'.length));
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        selectSample(
          periods[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? 2
                : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3
          ],
          true,
        );
      });
    }
    lastFocus = document.activeElement;
    $('sampleTaskDone').checked = false;
    $('sampleMemory')
      .querySelectorAll('[data-selected]')
      .forEach((node) => node.removeAttribute('data-selected'));
    selectSample('summary');
    $('sampleMemory').showModal();
  }
  function init() {
    if (!$('firstMemory')) return;
    initialized = true;
    $('firstMemoryRecord').addEventListener('click', record);
    $('firstMemoryMeeting').addEventListener('click', meeting);
    $('firstMemoryAccount').addEventListener('click', () => {
      root.SynapSettingsPanel.open();
      root.SynapSettingsPanel.select('memory', { focus: true });
    });
    $('firstMemorySample').addEventListener('click', openSample);
    $('supportSampleMemory').addEventListener('click', openSample);
    for (const event of [
      'synap-desktop-capture-started',
      'synap-desktop-capture-stopped',
      'synap-desktop-capture-changed',
      'synap-recording-foreground',
      'synap-memory-ready',
    ])
      root.addEventListener(event, render);
    root.SynapAuth?.onChange(render);
    new MutationObserver(render).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-state', 'data-startup', 'data-recording-interrupted'],
    });
    render();
  }
  root.SynapFirstMemory = Object.freeze({ update, openSample });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
