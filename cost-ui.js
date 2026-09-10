/* Approximate AI processing spend for the Synap recording pipeline.
 *
 * Rates are intentionally transparent estimates, not a billing ledger.
 * Snapshot: 2026-09-09.
 * - Gemini 3.5 Transcribe: official effective blended estimate USD 0.005/min.
 * - Gemini 3.5 Flash-Lite: USD 0.30/M input, USD 2.50/M output.
 * - Gemini Embedding 001: USD 0.15/M text input.
 * - Transcribe docs estimate ~175 output text tokens/min. Memory extraction uses
 *   the transcript as input; reserve ~35 structured-output tokens/min.
 * - FX snapshot: USD 1 = INR 94.85.
 *
 * This covers the automatic recording pipeline: transcription, structured-memory
 * LLM processing and semantic indexing. Ask Synap is user-triggered and is not
 * attributed to an individual recording here. Cloud Run, storage/network, taxes,
 * free-tier credits and speaker-service costs are also excluded.
 */
(function (root) {
  'use strict';

  const DB = 'dk-pendant-recordings';
  const USD_INR = 94.85;
  const TRANSCRIBE_MODEL = 'Gemini 3.5 Transcribe';
  const MEMORY_MODEL = 'Gemini 3.5 Flash-Lite';
  const EMBEDDING_MODEL = 'Gemini Embedding 001';
  const TRANSCRIBE_USD_PER_MIN = 0.005;
  const MEMORY_INPUT_TOKENS_PER_MIN = 175;
  const MEMORY_OUTPUT_TOKENS_PER_MIN = 35;
  const MEMORY_INPUT_USD_PER_M = 0.30;
  const MEMORY_OUTPUT_USD_PER_M = 2.50;
  const EMBEDDING_INPUT_USD_PER_M = 0.15;
  const STYLE_ID = 'synap-cost-ui-style';

  function minutes(recording) {
    return Math.max(0, Number(recording?.durationMs) || 0) / 60000;
  }

  function stage(recording) {
    return String(recording?.processingStage || recording?.state || '').toLowerCase();
  }

  function transcriptionCharged(recording) {
    const s = stage(recording);
    return Boolean(String(recording?.transcript || '').trim()) ||
      ['transcribing', 'understanding', 'indexing', 'ready'].includes(s) ||
      recording?.processingState === 'done';
  }

  function memoryCharged(recording) {
    const s = stage(recording);
    return Boolean(String(recording?.summary || '').trim()) ||
      Boolean(recording?.meeting) ||
      ['understanding', 'indexing', 'ready'].includes(s) ||
      recording?.processingState === 'done';
  }

  function embeddingCharged(recording) {
    const s = stage(recording);
    return ['indexing', 'ready'].includes(s) || recording?.processingState === 'done';
  }

  function conversations(recording) {
    const nested = recording?.meeting?.conversations;
    if (Array.isArray(nested)) return nested;
    return Array.isArray(recording?.conversations) ? recording.conversations : [];
  }

  function decisionText(value) {
    if (typeof value === 'string') return value;
    return typeof value?.text === 'string' ? value.text : '';
  }

  function estimateEmbeddingTokens(recording) {
    let chars = 0;
    for (const conversation of conversations(recording)) {
      const text = [
        conversation?.title,
        conversation?.summary,
        ...(Array.isArray(conversation?.topics) ? conversation.topics : []),
        ...(Array.isArray(conversation?.decisions) ? conversation.decisions.map(decisionText) : [])
      ].filter(Boolean).join('\n');
      chars += text.length;
    }
    if (chars > 0) return Math.max(1, Math.ceil(chars / 4));
    return Math.ceil(minutes(recording) * MEMORY_OUTPUT_TOKENS_PER_MIN);
  }

  function estimate(recording) {
    const mins = minutes(recording);
    const memoryInputTokens = Math.ceil(mins * MEMORY_INPUT_TOKENS_PER_MIN);
    const memoryOutputTokens = Math.ceil(mins * MEMORY_OUTPUT_TOKENS_PER_MIN);
    const embeddingTokens = estimateEmbeddingTokens(recording);

    const transcribeInr = transcriptionCharged(recording)
      ? mins * TRANSCRIBE_USD_PER_MIN * USD_INR
      : 0;
    const llmInputInr = memoryCharged(recording)
      ? memoryInputTokens * MEMORY_INPUT_USD_PER_M / 1000000 * USD_INR
      : 0;
    const llmOutputInr = memoryCharged(recording)
      ? memoryOutputTokens * MEMORY_OUTPUT_USD_PER_M / 1000000 * USD_INR
      : 0;
    const embeddingInr = embeddingCharged(recording)
      ? embeddingTokens * EMBEDDING_INPUT_USD_PER_M / 1000000 * USD_INR
      : 0;
    const memoryInr = llmInputInr + llmOutputInr;
    const llmProcessingInr = memoryInr + embeddingInr;
    const totalInr = transcribeInr + llmProcessingInr;

    const projectedTranscribeInr = mins * TRANSCRIBE_USD_PER_MIN * USD_INR;
    const projectedLlmInputInr = memoryInputTokens * MEMORY_INPUT_USD_PER_M / 1000000 * USD_INR;
    const projectedLlmOutputInr = memoryOutputTokens * MEMORY_OUTPUT_USD_PER_M / 1000000 * USD_INR;
    const projectedEmbeddingInr = embeddingTokens * EMBEDDING_INPUT_USD_PER_M / 1000000 * USD_INR;

    return {
      minutes: mins,
      memoryInputTokens,
      memoryOutputTokens,
      embeddingTokens,
      transcribeInr,
      llmInputInr,
      llmOutputInr,
      memoryInr,
      embeddingInr,
      llmProcessingInr,
      totalInr,
      projectedTranscribeInr,
      projectedMemoryInr: projectedLlmInputInr + projectedLlmOutputInr,
      projectedEmbeddingInr,
      projectedLlmProcessingInr: projectedLlmInputInr + projectedLlmOutputInr + projectedEmbeddingInr,
      projectedTotalInr: projectedTranscribeInr + projectedLlmInputInr + projectedLlmOutputInr + projectedEmbeddingInr
    };
  }

  function aggregate(values) {
    const keys = [
        'minutes', 'memoryInputTokens', 'memoryOutputTokens', 'embeddingTokens',
        'transcribeInr', 'llmInputInr', 'llmOutputInr', 'memoryInr', 'embeddingInr',
        'llmProcessingInr', 'totalInr', 'projectedTranscribeInr', 'projectedMemoryInr',
        'projectedEmbeddingInr', 'projectedLlmProcessingInr', 'projectedTotalInr'
      ];
    return (values || []).reduce(function (sum, value) {
      for (const key of keys) sum[key] += Number(value?.[key]) || 0;
      return sum;
    }, Object.fromEntries(keys.map(key => [key, 0])));
  }

  function money(value) {
    const amount = Math.max(0, Number(value) || 0);
    if (amount < 0.01) return '₹0.00';
    if (amount < 10) return '₹' + amount.toFixed(2);
    return '₹' + amount.toFixed(1);
  }

  function tokens(value) {
    const count = Math.max(0, Math.round(Number(value) || 0));
    return count.toLocaleString('en-IN');
  }

  function setText(element, value) {
    if (element && element.textContent !== String(value)) element.textContent = String(value);
  }

  function localDay(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }

  function injectStyle() {
    if (root.document?.getElementById(STYLE_ID)) return;
    const style = root.document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.ai-cost-breakdown{display:block;margin-top:6px;border:0;color:var(--muted);font-size:8px;line-height:1.35}' +
      '.ai-cost-breakdown>summary{list-style:none;display:flex;align-items:center;gap:7px;cursor:pointer;min-width:0}' +
      '.ai-cost-breakdown>summary::-webkit-details-marker,.ai-cost-category>summary::-webkit-details-marker{display:none}' +
      '.ai-cost-breakdown>summary .ai-cost-label{min-width:0;flex:1}' +
      '.ai-cost-breakdown>summary strong{font-variant-numeric:tabular-nums;color:inherit;white-space:nowrap}' +
      '.ai-cost-chevron{font-size:9px;transition:transform .16s ease}' +
      '.ai-cost-breakdown[open]>summary .ai-cost-chevron,.ai-cost-category[open]>summary .ai-cost-chevron{transform:rotate(180deg)}' +
      '.ai-cost-body{display:grid;gap:5px;margin-top:7px;padding:7px 8px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2)}' +
      '.ai-cost-category{margin:0;border:0}' +
      '.ai-cost-category>summary{list-style:none;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px;cursor:pointer}' +
      '.ai-cost-category>summary strong{font-variant-numeric:tabular-nums;color:var(--text);font-size:8px}' +
      '.ai-cost-detail{display:grid;gap:2px;padding:5px 0 1px 0;color:var(--muted);font-size:7px}' +
      '.ai-cost-note{margin-top:2px;padding-top:5px;border-top:1px solid var(--border);font-size:7px;color:var(--muted)}' +
      '.recording-cost-estimate{width:100%}' +
      '.today-cost-estimate{margin-top:9px;padding-top:9px;border-top:1px solid rgba(255,255,255,.12);color:#b9c8d9}' +
      '.today-cost-estimate .ai-cost-body{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.05)}' +
      '.today-cost-estimate .ai-cost-category>summary strong,.today-cost-estimate>summary strong{color:#fff}' +
      '@media(min-width:600px){.ai-cost-breakdown{font-size:10px}.ai-cost-category>summary strong{font-size:10px}.ai-cost-detail,.ai-cost-note{font-size:9px}}';
    root.document.head?.appendChild(style);
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const request = root.indexedDB.open(DB);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function recordings() {
    const db = await openDb();
    try {
      return await new Promise(function (resolve, reject) {
        const request = db.transaction('recordings').objectStore('recordings').getAll();
        request.onsuccess = function () { resolve(request.result || []); };
        request.onerror = function () { reject(request.error); };
      });
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  function recordingId(card) {
    const explicit = card?.dataset?.recordingId;
    if (explicit) return explicit;
    const id = String(card?.id || '');
    return id.startsWith('recording-') ? id.slice('recording-'.length) : '';
  }

  function ensureBreakdown(parent, className) {
    let details = parent?.querySelector?.('.' + className);
    if (details) return details;
    details = root.document.createElement('details');
    details.className = 'ai-cost-breakdown ' + className;
    details.innerHTML =
      '<summary><span class="ai-cost-label">Approx. AI spend</span><strong data-cost="total">₹0.00</strong><span class="ai-cost-chevron" aria-hidden="true">⌄</span></summary>' +
      '<div class="ai-cost-body">' +
        '<details class="ai-cost-category" data-category="transcription"><summary><span>Transcription</span><strong data-cost="transcription">₹0.00</strong><span class="ai-cost-chevron" aria-hidden="true">⌄</span></summary><div class="ai-cost-detail"><span data-detail="transcription-model"></span><span data-detail="transcription-usage"></span></div></details>' +
        '<details class="ai-cost-category" data-category="llm"><summary><span>LLM processing</span><strong data-cost="llm">₹0.00</strong><span class="ai-cost-chevron" aria-hidden="true">⌄</span></summary><div class="ai-cost-detail"><span data-detail="memory-model"></span><span data-detail="memory-usage"></span><span data-detail="embedding-model"></span><span data-detail="embedding-usage"></span></div></details>' +
        '<div class="ai-cost-note">Automatic pipeline estimate only. Ask Synap and cloud infrastructure are separate.</div>' +
      '</div>';
    parent.appendChild(details);
    return details;
  }

  function updateBreakdown(details, value, projected) {
    const total = projected ? value.projectedTotalInr : value.totalInr;
    const transcribe = projected ? value.projectedTranscribeInr : value.transcribeInr;
    const llm = projected ? value.projectedLlmProcessingInr : value.llmProcessingInr;
    const memory = projected ? value.projectedMemoryInr : value.memoryInr;
    const embedding = projected ? value.projectedEmbeddingInr : value.embeddingInr;

    setText(details.querySelector('.ai-cost-label'), projected ? 'Projected AI processing' : 'Approx. AI spend');
    setText(details.querySelector('[data-cost="total"]'), money(total));
    setText(details.querySelector('[data-cost="transcription"]'), money(transcribe));
    setText(details.querySelector('[data-cost="llm"]'), money(llm));
    setText(details.querySelector('[data-detail="transcription-model"]'), TRANSCRIBE_MODEL + ' · ' + value.minutes.toFixed(1) + ' min');
    setText(details.querySelector('[data-detail="transcription-usage"]'), 'Rate: $0.005/min blended');
    setText(details.querySelector('[data-detail="memory-model"]'), 'Memory extraction · ' + MEMORY_MODEL + ' · ' + money(memory));
    setText(details.querySelector('[data-detail="memory-usage"]'), '~' + tokens(value.memoryInputTokens) + ' input + ' + tokens(value.memoryOutputTokens) + ' output tokens');
    setText(details.querySelector('[data-detail="embedding-model"]'), 'Semantic indexing · ' + EMBEDDING_MODEL + ' · ' + money(embedding));
    setText(details.querySelector('[data-detail="embedding-usage"]'), '~' + tokens(value.embeddingTokens) + ' text tokens embedded');
    details.title = 'Estimated automatic AI pipeline spend in INR using 2026-09-09 model pricing and FX snapshot.';
  }

  function decorateLibrary(items) {
    const byId = new Map((items || []).map(function (item) { return [String(item.id), item]; }));
    root.document?.querySelectorAll?.('#recordingsList .recording-card').forEach(function (card) {
      const recording = byId.get(recordingId(card));
      if (!recording) return;
      const head = card.querySelector('.recording-processing-head');
      if (!head) return;
      const value = estimate(recording);
      const details = ensureBreakdown(head, 'recording-cost-estimate');
      updateBreakdown(details, value, value.totalInr <= 0);
    });
  }

  function decorateToday(items) {
    const panel = root.document?.getElementById('todayMemoryPipeline');
    if (!panel) return;
    const selected = root.document.getElementById('datePicker')?.value || localDay(new Date());
    const sameDay = (items || []).filter(function (item) { return localDay(item.createdAt) === selected; });
    const value = aggregate(sameDay.map(estimate));
    const details = ensureBreakdown(panel, 'today-cost-estimate');
    updateBreakdown(details, value, sameDay.length > 0 && value.totalInr <= 0);
  }

  let refreshTimer = 0;
  let refreshing = false;
  function schedule(delay) {
    root.clearTimeout(refreshTimer);
    refreshTimer = root.setTimeout(refresh, Number.isFinite(delay) ? delay : 80);
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      injectStyle();
      const items = await recordings().catch(function () { return []; });
      decorateLibrary(items);
      decorateToday(items);
    } finally {
      refreshing = false;
    }
  }

  function init() {
    injectStyle();
    const library = root.document?.getElementById('recordingsList');
    if (library && root.MutationObserver) {
      new MutationObserver(function () { schedule(40); }).observe(library, { childList: true, subtree: true });
    }
    root.document?.getElementById('datePicker')?.addEventListener('change', function () { schedule(20); });
    ['synap-processing-state', 'synap-memory-ready', 'synap-cloud-history-updated', 'synap-transcript-updated'].forEach(function (name) {
      root.addEventListener?.(name, function () { schedule(30); });
    });
    schedule(250);
  }

  if (root.document?.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  root.SynapCostUI = Object.freeze({
    USD_INR,
    TRANSCRIBE_USD_PER_MIN,
    MEMORY_INPUT_TOKENS_PER_MIN,
    MEMORY_OUTPUT_TOKENS_PER_MIN,
    EMBEDDING_INPUT_USD_PER_M,
    estimate,
    aggregate,
    money
  });
})(globalThis);
