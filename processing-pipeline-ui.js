/* Visible per-recording memory pipeline.
 *
 * The recording engine intentionally stays untouched. This module reads the
 * durable local recording/job state and decorates Library cards with a truthful
 * processing view. For Synap Cloud, backend state is persisted by
 * synap-backend.js as:
 *
 *   uploading -> uploaded -> transcribing -> understanding -> indexing -> ready
 *
 * Users see the simpler product language:
 *
 *   Recorded -> Upload -> Transcription -> Summary -> Ready
 */
(function (root) {
  'use strict';

  var DB_NAME = 'dk-pendant-recordings';
  var PREF_KEY = 'synap-ai-provider-settings';
  var SETTINGS_KEY = 'dk-pendant-settings';
  var STYLE_ID = 'synap-processing-pipeline-style';
  var refreshTimer = 0;
  var refreshRunning = false;
  var refreshAgain = false;

  function readJson(key) {
    try {
      var value = JSON.parse(root.localStorage.getItem(key) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function runtimeContext(recording) {
    var provider = String((recording && recording.provider) || readJson(PREF_KEY).provider || 'synap');
    var signedIn = Boolean(root.SynapAuth && typeof root.SynapAuth.isSignedIn === 'function' && root.SynapAuth.isSignedIn());
    var settings = readJson(SETTINGS_KEY);
    return { provider: provider, signedIn: signedIn, autoProcess: settings.autoProcess === true };
  }

  function jobsOf(jobs, kind) {
    return (jobs || []).filter(function (job) { return job && job.kind === kind; });
  }

  function allDone(jobs) {
    return jobs.length > 0 && jobs.every(function (job) { return job.state === 'done'; });
  }

  function anyState(jobs, state) {
    return jobs.some(function (job) { return job.state === state; });
  }

  function step(key, label, state) {
    return { key: key, label: label, state: state || 'pending' };
  }

  function laterThan(stage, threshold) {
    var order = ['uploading', 'uploaded', 'transcribing', 'understanding', 'indexing', 'ready'];
    return order.indexOf(stage) >= order.indexOf(threshold) && order.indexOf(threshold) >= 0;
  }

  function percent(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, Math.round(number * 100)));
  }

  function firstPendingStep(steps) {
    return steps.find(function (item) { return item.state === 'active' || item.state === 'pending'; }) || steps[steps.length - 1];
  }

  function deriveCloud(recording, jobs, context) {
    var uploadJobs = jobsOf(jobs, 'transcribe');
    var consolidateJobs = jobsOf(jobs, 'consolidate');
    var failedJob = jobs.find(function (job) { return job.state === 'failed'; });
    var stage = String(recording.processingStage || '').toLowerCase();
    var failedStage = String(recording.processingFailedStage || '').toLowerCase();
    var ready = recording.processingState === 'done' || stage === 'ready';
    var sealed = recording.sealed !== false && recording.status !== 'recording';

    var steps = [
      step('recorded', 'Recorded', sealed ? 'done' : 'active'),
      step('upload', 'Upload'),
      step('transcription', 'Transcription'),
      step('summary', 'Summary'),
      step('ready', 'Ready')
    ];

    if (ready) {
      steps.forEach(function (item) { item.state = 'done'; });
      return { status: 'Ready', tone: 'ready', percent: 100, steps: steps };
    }

    var uploadDone = laterThan(stage, 'uploaded') || allDone(uploadJobs);
    var uploadActive = stage === 'uploading' || anyState(uploadJobs, 'running') ||
      (uploadJobs.length > 0 && uploadJobs.some(function (job) { return job.state === 'done'; }) && !allDone(uploadJobs));
    if (uploadDone) steps[1].state = 'done';
    else if (uploadActive) steps[1].state = 'active';

    if (laterThan(stage, 'understanding')) steps[2].state = 'done';
    else if (stage === 'transcribing') steps[2].state = 'active';

    if (laterThan(stage, 'indexing')) steps[3].state = 'done';
    else if (stage === 'understanding') steps[3].state = 'active';

    if (stage === 'indexing') steps[4].state = 'active';

    var failureKey = '';
    if (failedJob && failedJob.kind === 'transcribe') failureKey = 'upload';
    else if (failedStage === 'transcribing') failureKey = 'transcription';
    else if (failedStage === 'understanding') failureKey = 'summary';
    else if (failedStage === 'indexing') failureKey = 'ready';
    else if (stage === 'failed' || (failedJob && failedJob.kind === 'consolidate')) {
      failureKey = firstPendingStep(steps).key;
    }
    if (failureKey) {
      var failedStep = steps.find(function (item) { return item.key === failureKey; });
      if (failedStep) failedStep.state = 'error';
      return {
        status: 'Needs retry',
        tone: 'error',
        percent: percent(recording.processingProgress),
        error: recording.processingError || (failedJob && failedJob.lastError) || 'Processing stopped before this memory was ready.',
        retryable: recording.processingRetryable !== false,
        steps: steps
      };
    }

    var progress = percent(recording.processingProgress);
    if (stage === 'transcribing') return { status: 'Transcribing' + (progress === null ? '' : ' · ' + progress + '%'), tone: 'active', percent: progress, steps: steps };
    if (stage === 'understanding') return { status: 'Summarizing' + (progress === null ? '' : ' · ' + progress + '%'), tone: 'active', percent: progress, steps: steps };
    if (stage === 'indexing') return { status: 'Finalizing' + (progress === null ? '' : ' · ' + progress + '%'), tone: 'active', percent: progress, steps: steps };
    if (stage === 'uploaded' || anyState(consolidateJobs, 'running')) return { status: 'Starting transcription…', tone: 'active', percent: progress, steps: steps };
    if (uploadActive) {
      var uploaded = uploadJobs.filter(function (job) { return job.state === 'done'; }).length;
      var uploadPercent = uploadJobs.length ? Math.round(uploaded * 100 / uploadJobs.length) : null;
      return { status: 'Uploading' + (uploadPercent === null ? '' : ' · ' + uploadPercent + '%'), tone: 'active', percent: uploadPercent, steps: steps };
    }

    var pending = jobs.some(function (job) { return job.state === 'pending' || job.state === 'running'; });
    if (pending && !context.signedIn) return { status: 'Waiting for sign-in', tone: 'waiting', percent: null, steps: steps };
    if (pending && !context.autoProcess) return { status: 'Ready to process', tone: 'waiting', percent: null, steps: steps };
    if (pending) return { status: 'Queued', tone: 'waiting', percent: null, steps: steps };
    return { status: sealed ? 'Recorded' : 'Recording', tone: 'waiting', percent: null, steps: steps };
  }

  function deriveCustom(recording, jobs) {
    var transcribe = jobsOf(jobs, 'transcribe');
    var summarize = jobsOf(jobs, 'summarize');
    var consolidate = jobsOf(jobs, 'consolidate');
    var ready = recording.processingState === 'done' || Boolean(recording.summary && String(recording.summary).trim());
    var steps = [
      step('recorded', 'Recorded', 'done'),
      step('transcription', 'Transcription'),
      step('summary', 'Summary'),
      step('ready', 'Ready')
    ];
    if (ready) {
      steps.forEach(function (item) { item.state = 'done'; });
      return { status: 'Ready', tone: 'ready', percent: 100, steps: steps };
    }
    if (allDone(transcribe)) steps[1].state = 'done'; else if (anyState(transcribe, 'running')) steps[1].state = 'active';
    if (allDone(summarize)) steps[2].state = 'done'; else if (anyState(summarize, 'running')) steps[2].state = 'active';
    if (anyState(consolidate, 'running')) steps[3].state = 'active';
    var failed = jobs.find(function (job) { return job.state === 'failed'; });
    if (failed) {
      var key = failed.kind === 'transcribe' ? 'transcription' : failed.kind === 'summarize' ? 'summary' : 'ready';
      steps.find(function (item) { return item.key === key; }).state = 'error';
      return { status: 'Needs retry', tone: 'error', error: failed.lastError || 'Processing failed.', steps: steps };
    }
    if (anyState(transcribe, 'running')) return { status: 'Transcribing', tone: 'active', steps: steps };
    if (anyState(summarize, 'running')) return { status: 'Summarizing', tone: 'active', steps: steps };
    if (anyState(consolidate, 'running')) return { status: 'Finalizing', tone: 'active', steps: steps };
    return { status: jobs.length ? 'Queued' : 'Recorded', tone: 'waiting', steps: steps };
  }

  function derive(recording, jobs, context) {
    recording = recording || {};
    jobs = Array.isArray(jobs) ? jobs : [];
    context = context || runtimeContext(recording);
    return context.provider === 'custom'
      ? deriveCustom(recording, jobs, context)
      : deriveCloud(recording, jobs, context);
  }

  function injectStyles() {
    if (!root.document || root.document.getElementById(STYLE_ID)) return;
    var style = root.document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.recording-pipeline-status{display:inline-flex;align-items:center;gap:5px;width:max-content;max-width:100%;margin-top:4px;padding:3px 7px;border-radius:999px;background:var(--surface-2);color:var(--muted);font-size:8px;font-weight:720;line-height:1.25;white-space:nowrap}' +
      '.recording-pipeline-status::before{content:"";width:5px;height:5px;flex:0 0 5px;border-radius:50%;background:currentColor;opacity:.8}' +
      '.recording-pipeline-status[data-tone="active"]{background:var(--accent-soft);color:var(--accent)}' +
      '.recording-pipeline-status[data-tone="ready"]{background:var(--success-soft);color:var(--success)}' +
      '.recording-pipeline-status[data-tone="error"]{background:var(--rose-soft);color:var(--rose)}' +
      '.recording-processing-pipeline{margin:12px 0 4px;padding:12px;border:1px solid var(--border);border-radius:13px;background:var(--surface-2)}' +
      '.recording-processing-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:11px}' +
      '.recording-processing-head strong{font-size:10px;font-weight:760}.recording-processing-head span{font-size:8px;color:var(--muted);text-align:right}' +
      '.recording-processing-track{display:grid;grid-template-columns:repeat(var(--pipeline-steps),minmax(0,1fr));gap:0;overflow:visible}' +
      '.recording-processing-step{position:relative;min-width:0;text-align:center;color:var(--muted)}' +
      '.recording-processing-step::before{content:"";position:absolute;z-index:0;top:5px;right:50%;width:100%;height:2px;background:var(--border)}' +
      '.recording-processing-step:first-child::before{display:none}' +
      '.recording-processing-dot{position:relative;z-index:1;display:block;width:11px;height:11px;margin:0 auto 5px;border:2px solid var(--border);border-radius:50%;background:var(--surface)}' +
      '.recording-processing-step span:last-child{display:block;padding:0 2px;font-size:7px;line-height:1.25;overflow-wrap:anywhere}' +
      '.recording-processing-step[data-state="done"]{color:var(--success)}.recording-processing-step[data-state="done"]::before{background:var(--success)}.recording-processing-step[data-state="done"] .recording-processing-dot{border-color:var(--success);background:var(--success)}' +
      '.recording-processing-step[data-state="active"]{color:var(--accent);font-weight:720}.recording-processing-step[data-state="active"] .recording-processing-dot{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}' +
      '.recording-processing-step[data-state="error"]{color:var(--rose);font-weight:720}.recording-processing-step[data-state="error"] .recording-processing-dot{border-color:var(--rose);background:var(--rose)}' +
      '.recording-processing-progress{height:4px;margin-top:10px;border-radius:999px;background:var(--border);overflow:hidden}.recording-processing-progress span{display:block;height:100%;border-radius:inherit;background:var(--accent);transition:width .25s ease}' +
      '.recording-processing-error{margin:9px 0 0;color:var(--rose);font-size:8px;line-height:1.4;overflow-wrap:anywhere}' +
      '@media(min-width:600px){.recording-pipeline-status{font-size:10px}.recording-processing-head strong{font-size:12px}.recording-processing-head span,.recording-processing-error{font-size:10px}.recording-processing-step span:last-child{font-size:9px}}';
    root.document.head.appendChild(style);
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var request = root.indexedDB.open(DB_NAME);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function getAll(store) {
    return new Promise(function (resolve, reject) {
      var request = store.getAll();
      request.onsuccess = function () { resolve(request.result || []); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function snapshot() {
    var db = await openDb();
    try {
      if (!db.objectStoreNames.contains('recordings')) return { recordings: [], jobs: [] };
      var names = ['recordings'];
      if (db.objectStoreNames.contains('jobs')) names.push('jobs');
      var tx = db.transaction(names, 'readonly');
      var recordings = await getAll(tx.objectStore('recordings'));
      var jobs = names.indexOf('jobs') >= 0 ? await getAll(tx.objectStore('jobs')) : [];
      return { recordings: recordings, jobs: jobs };
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  function setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  function ensureStatus(card, model) {
    var info = card.querySelector('.recording-row-info');
    if (!info) return;
    var status = info.querySelector('.recording-pipeline-status');
    if (!status) {
      status = root.document.createElement('span');
      status.className = 'recording-pipeline-status';
      status.setAttribute('aria-live', 'polite');
      info.appendChild(status);
    }
    status.dataset.tone = model.tone || 'waiting';
    setText(status, model.status);
  }

  function ensureExpanded(card, model) {
    var content = card.querySelector('.recording-content');
    if (!content) return;
    var pipeline = content.querySelector('.recording-processing-pipeline');
    if (!pipeline) {
      pipeline = root.document.createElement('section');
      pipeline.className = 'recording-processing-pipeline';
      pipeline.setAttribute('aria-label', 'Memory processing pipeline');
      var actions = content.querySelector('.recording-actions');
      if (actions && actions.nextSibling) content.insertBefore(pipeline, actions.nextSibling);
      else if (actions) actions.insertAdjacentElement('afterend', pipeline);
      else content.insertBefore(pipeline, content.firstChild);
    }

    var head = root.document.createElement('div');
    head.className = 'recording-processing-head';
    var title = root.document.createElement('strong');
    title.textContent = 'Memory pipeline';
    var status = root.document.createElement('span');
    status.textContent = model.status;
    head.append(title, status);

    var track = root.document.createElement('div');
    track.className = 'recording-processing-track';
    track.style.setProperty('--pipeline-steps', String(model.steps.length));
    model.steps.forEach(function (item) {
      var itemEl = root.document.createElement('div');
      itemEl.className = 'recording-processing-step';
      itemEl.dataset.state = item.state;
      var dot = root.document.createElement('span');
      dot.className = 'recording-processing-dot';
      dot.setAttribute('aria-hidden', 'true');
      var label = root.document.createElement('span');
      label.textContent = item.label;
      itemEl.append(dot, label);
      track.appendChild(itemEl);
    });

    var children = [head, track];
    if (model.percent !== null && model.percent !== undefined && model.tone === 'active') {
      var progress = root.document.createElement('div');
      progress.className = 'recording-processing-progress';
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      progress.setAttribute('aria-valuenow', String(model.percent));
      var fill = root.document.createElement('span');
      fill.style.width = model.percent + '%';
      progress.appendChild(fill);
      children.push(progress);
    }
    if (model.error) {
      var error = root.document.createElement('p');
      error.className = 'recording-processing-error';
      error.textContent = model.error + (model.retryable === false ? '' : ' Use Process queue to retry.');
      children.push(error);
    }
    pipeline.replaceChildren.apply(pipeline, children);
  }

  function decorate(card, recording, jobs) {
    var model = derive(recording, jobs, runtimeContext(recording));
    ensureStatus(card, model);
    ensureExpanded(card, model);
  }

  async function refresh() {
    if (!root.document) return;
    if (refreshRunning) { refreshAgain = true; return; }
    var list = root.document.getElementById('recordingsList');
    if (!list || !list.querySelector('.recording-card')) return;
    refreshRunning = true;
    try {
      var data = await snapshot();
      var recordingById = new Map(data.recordings.map(function (recording) { return [String(recording.id), recording]; }));
      var jobsByRecording = new Map();
      data.jobs.forEach(function (job) {
        var id = String(job.recordingId || '');
        if (!jobsByRecording.has(id)) jobsByRecording.set(id, []);
        jobsByRecording.get(id).push(job);
      });
      list.querySelectorAll('.recording-card').forEach(function (card) {
        var id = String(card.id || '').replace(/^recording-/, '');
        var recording = recordingById.get(id);
        if (recording) decorate(card, recording, jobsByRecording.get(id) || []);
      });
    } catch (_) {
      // Pipeline visibility must never interfere with capture or Library rendering.
    } finally {
      refreshRunning = false;
      if (refreshAgain) { refreshAgain = false; scheduleRefresh(60); }
    }
  }

  function scheduleRefresh(delay) {
    root.clearTimeout(refreshTimer);
    refreshTimer = root.setTimeout(refresh, delay == null ? 80 : delay);
  }

  function interestingMutation(mutation) {
    return Array.prototype.some.call(mutation.addedNodes || [], function (node) {
      if (!node || node.nodeType !== 1) return false;
      return (node.matches && node.matches('.recording-card,.recording-content')) ||
        (node.querySelector && node.querySelector('.recording-card,.recording-content'));
    });
  }

  function bind() {
    if (!root.document) return;
    injectStyles();
    var list = root.document.getElementById('recordingsList');
    if (list && root.MutationObserver) {
      new root.MutationObserver(function (mutations) {
        if (mutations.some(interestingMutation)) scheduleRefresh();
      }).observe(list, { childList: true, subtree: true });
    }
    var queue = root.document.getElementById('queueStatus');
    if (queue && root.MutationObserver) {
      new root.MutationObserver(function () { scheduleRefresh(40); })
        .observe(queue, { childList: true, subtree: true, characterData: true });
    }
    var provider = root.document.getElementById('providerInput');
    if (provider) provider.addEventListener('change', function () { scheduleRefresh(40); });
    if (root.SynapAuth && typeof root.SynapAuth.onChange === 'function') {
      root.SynapAuth.onChange(function () { scheduleRefresh(40); });
    }
    root.document.addEventListener('toggle', function (event) {
      if (event.target && event.target.classList && event.target.classList.contains('recording-card')) scheduleRefresh(20);
    }, true);
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('synap-processing-state', function () { scheduleRefresh(20); });
      root.addEventListener('synap-memory-ready', function () { scheduleRefresh(20); });
      root.addEventListener('synap-cloud-history-updated', function () { scheduleRefresh(20); });
    }
    scheduleRefresh(300);
  }

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }

  root.SynapProcessingPipeline = { derive: derive, refresh: refresh, scheduleRefresh: scheduleRefresh };
})(globalThis);
