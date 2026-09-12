/* Grounded Ask Synap client. Uses Synap Cloud when signed in; local recall remains the offline fallback. */
(function (root) {
  'use strict';

  const ASK_ENDPOINT = '/v1/ask';
  const MAX_SOURCES = 8;
  const SEARCH_TIMEOUT_MS = 20000;
  let requestGeneration = 0;
  let activeRequest = null;
  let displayedAccount = null;

  function accountKey() {
    try { return cloudReady() ? String(root.SynapAuth.session?.()?.profile?.uid || 'signed-in') : ''; }
    catch (_) { return ''; }
  }

  function cancelSearch(message) {
    requestGeneration++;
    activeRequest?.abort();
    activeRequest = null;
    displayedAccount = null;
    setBusy(false);
    if (answerBox()) answerBox().textContent = message || '';
  }

  function $(selector) { return document.querySelector(selector); }

  function cloudReady() {
    try {
      return Boolean(root.SynapAuth && root.SynapAuth.isSignedIn && root.SynapAuth.isSignedIn() &&
        root.SynapAuth.config && root.SynapAuth.config().backendUrl);
    } catch (_) { return false; }
  }

  function text(node, value) {
    if (node) node.textContent = value == null ? '' : String(value);
    return node;
  }

  function answerBox() { return $('#askAnswer'); }

  function setBusy(active) {
    const form = $('#askForm');
    const input = $('#askInput');
    const button = form && form.querySelector('button[type="submit"]');
    if (form) form.setAttribute('aria-busy', active ? 'true' : 'false');
    if (input) input.disabled = active;
    if (button) {
      button.disabled = active;
      button.textContent = active ? 'Searching…' : 'Ask';
    }
  }

  function showSearching() {
    const out = answerBox();
    if (!out) return;
    out.replaceChildren();
    const p = document.createElement('p');
    p.className = 'brain-empty ask-searching';
    p.textContent = 'Searching your Synap memories…';
    out.appendChild(p);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel search';
    cancel.addEventListener('click', () => cancelSearch('Search cancelled. You can ask another question.'));
    out.appendChild(cancel);
  }

  function showError(error, query) {
    const out = answerBox();
    if (!out) return;
    out.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'answer-copy ask-error';
    const mark = document.createElement('span');
    mark.className = 'answer-mark';
    mark.textContent = '!';
    const body = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'Ask Synap could not complete that search';
    const message = document.createElement('p');
    message.textContent = error && error.message ? error.message : 'Please try again.';
    body.append(title, message);
    wrap.append(mark, body);
    out.appendChild(wrap);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry search';
    retry.addEventListener('click', () => cloudReady() ? askCloud(query) : searchLocal(query));
    const local = document.createElement('button');
    local.type = 'button';
    local.textContent = 'Search this device';
    local.addEventListener('click', () => searchLocal(query));
    out.append(retry, local);
  }

  async function searchLocal(query) {
    cancelSearch();
    const generation = requestGeneration;
    try {
      await root.SynapBrainUI?.refresh();
      if (generation !== requestGeneration) return;
      root.SynapBrainUI?.answerLocal(query);
      const scope = document.createElement('p');
      scope.className = 'ask-search-meta';
      scope.textContent = 'Searched saved memories on this device.';
      answerBox()?.prepend(scope);
    } catch (error) { if (generation === requestGeneration) showError(error, query); }
  }

  function sourceButton(source, index) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source-jump ask-source';
    button.dataset.id = source.recording_id || '';
    if (source.start_ms != null) button.dataset.startMs = String(source.start_ms);

    const label = document.createElement('strong');
    label.textContent = `Source ${index + 1}`;
    const detail = document.createElement('small');
    const seconds = Math.max(0, Math.round(Number(source.start_ms || 0) / 1000));
    detail.textContent = seconds ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : 'Recorded memory';
    button.append(label, detail);

    if (source.quote) {
      const quote = document.createElement('span');
      quote.className = 'ask-source-quote';
      quote.textContent = source.quote;
      button.appendChild(quote);
    }
    return button;
  }

  function renderAnswer(result) {
    const out = answerBox();
    if (!out) return;
    out.replaceChildren();

    const copy = document.createElement('div');
    copy.className = 'answer-copy';
    const mark = document.createElement('span');
    mark.className = 'answer-mark';
    mark.textContent = '✦';
    const body = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = result.confidence === 'none' ? 'From your memory' : 'Grounded in your memory';
    const answer = document.createElement('p');
    answer.className = 'ask-answer-text';
    answer.textContent = result.answer || 'I could not find an answer in your processed memories.';
    body.append(heading, answer);

    if (result.confidence && result.confidence !== 'none') {
      const confidence = document.createElement('small');
      confidence.className = 'ask-confidence';
      confidence.textContent = `${result.confidence} confidence`;
      body.appendChild(confidence);
    }
    copy.append(mark, body);
    out.appendChild(copy);

    const sources = Array.isArray(result.sources) ? result.sources : [];
    if (sources.length) {
      const sourceWrap = document.createElement('div');
      sourceWrap.className = 'answer-sources';
      const sourceTitle = document.createElement('span');
      sourceTitle.textContent = 'Sources';
      sourceWrap.appendChild(sourceTitle);
      sources.slice(0, MAX_SOURCES).forEach((source, index) => sourceWrap.appendChild(sourceButton(source, index)));
      out.appendChild(sourceWrap);
    }

    if (result.searched && Number.isFinite(Number(result.searched.conversations))) {
      const meta = document.createElement('p');
      meta.className = 'ask-search-meta';
      const count = Number(result.searched.conversations);
      meta.textContent = `Searched ${count} relevant conversation${count === 1 ? '' : 's'}.`;
      out.appendChild(meta);
    }
  }

  async function askCloud(query) {
    const clean = String(query || '').trim();
    if (!clean) return;
    activeRequest?.abort();
    const generation = ++requestGeneration;
    const account = accountKey();
    displayedAccount = account;
    const controller = new AbortController();
    activeRequest = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SEARCH_TIMEOUT_MS);
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => {
      reject(new Error(timedOut ? 'Search timed out. Please retry or search this device.' : 'Search cancelled.'));
    }, { once: true }));
    setBusy(true);
    showSearching();
    try {
      const result = await Promise.race([aborted, (async () => {
        const response = await root.SynapAuth.authedFetch(ASK_ENDPOINT, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: clean, max_sources: MAX_SOURCES })
        });
        const raw = await response.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
        if (!response.ok) {
          const message = data && data.error && data.error.message ? data.error.message : `HTTP ${response.status}`;
          const error = new Error(message);
          error.status = response.status;
          throw error;
        }
        if (!data || typeof data.answer !== 'string') throw new Error('The search returned an incomplete answer. Please retry.');
        return data;
      })()]);
      if (generation !== requestGeneration || account !== accountKey()) return;
      renderAnswer(result);
    } catch (error) {
      if (generation !== requestGeneration || account !== accountKey()) return;
      showError(error, clean);
    } finally {
      clearTimeout(timer);
      if (generation === requestGeneration) { activeRequest = null; setBusy(false); }
    }
  }

  function openAsk(query) {
    if (root.SynapDashboardUI && typeof root.SynapDashboardUI.setView === 'function') {
      root.SynapDashboardUI.setView('ask');
    } else {
      try { location.hash = '#ask'; } catch (_) {}
    }
    const input = $('#askInput');
    if (input && query != null) input.value = String(query);
    if (cloudReady() && query) askCloud(query);
    else if (query) $('#askForm')?.requestSubmit();
    else if (input) setTimeout(() => input.focus(), 0);
  }

  function enhanceAskCopy() {
    const section = $('#ask');
    if (!section) return;
    const ready = cloudReady();
    section.dataset.askMode = ready ? 'cloud' : 'local';
    const copy = section.querySelector('.section-copy');
    const value = ready
      ? 'Ask across your processed synap memories. Answers are grounded and linked to their sources.'
      : 'Ask locally from memories on this device. Sign in to synap Cloud for grounded semantic recall.';
    if (copy && copy.textContent !== value) copy.textContent = value;
  }

  function onSubmit(event) {
    const form = event.target;
    if (!form || form.id !== 'askForm' || !cloudReady()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const input = $('#askInput');
    askCloud(input ? input.value : '');
  }

  function onClick(event) {
    const target = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!target) return;

    if (target.closest('.ask-suggestions') && cloudReady()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const input = $('#askInput');
      if (input) input.value = target.textContent || '';
      askCloud(target.textContent || '');
      return;
    }

    if (target.matches('.person-card') && target.dataset.person && cloudReady()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openAsk(target.dataset.person);
      return;
    }

    if (target.closest('#contextChips') && target.dataset.query && cloudReady()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openAsk(target.dataset.query);
    }
  }

  function scan() { enhanceAskCopy(); }

  function init() {
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('click', onClick, true);
    let account = accountKey();
    if (root.SynapAuth && root.SynapAuth.onChange) root.SynapAuth.onChange(() => {
      const next = accountKey();
      if (account !== next || (displayedAccount !== null && displayedAccount !== next)) cancelSearch();
      account = next;
      scan();
    });
    scan();
    // Ask is inserted as a direct main section. Descendant changes, including
    // our own copy write, must not schedule another scan every animation frame.
    const main = $('main') || document.body;
    let queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; scan(); });
    }).observe(main, { childList: true });
  }

  root.SynapAsk = { ask: askCloud, open: openAsk, cloudReady: cloudReady };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
